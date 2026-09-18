/**
 * One Command Code session for one thread.
 *
 * Print mode is one turn per process (spec 5.1): `send` spawns
 * `cmd -p "<prompt>" --session <sessionId> --yolo` and the harness resumes its
 * own persisted session. `--yolo` keeps the CLI from ever blocking on its own
 * prompts — approvals flow through our PreToolUse hook instead, which the
 * HookBridge route answers. `interactionMode: "plan"` adds
 * `--permission-mode plan` on top; it does not replace `--yolo`, because
 * without it the harness refuses even to write the plan file.
 *
 * Three sources feed the event stream: NDJSON frames on stdout, the session
 * transcript the harness appends on disk, and hook posts. The translator —
 * one per session, not per process — dedupes the overlap across turns; the
 * turn-scoped wrapper settles turns.
 */
import * as NodeFS from "node:fs";
import type { ConnectorInstanceId, ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import type { ConnectorCapabilities, RuntimeEvent } from "@OpenAde/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@OpenAde/connector-sdk/definition";
import { SessionClosed, SpawnFailed, TurnInProgress } from "@OpenAde/connector-sdk/definition";
import { makeBoundedEventQueue, type SessionHandle } from "@OpenAde/connector-sdk/sessionHandle";
import { makeEventId, makeTurnId } from "@OpenAde/contracts/ids";

import {
  installProjectHooks,
  removeMcpEntry,
  uninstallProjectHooks,
  upsertMcpEntry,
  type InstalledFile,
} from "./config";
import { stageTurnAttachments } from "./attachments";
import { ensureHookScript, hookTicketPath, removeHookTicket, writeHookTicket } from "./hookScript";
import { makeHookAnswerer } from "./hookAnswers";
import { makeLineSplitter, parseFrame } from "./ndjson";
import { readPlanProposal } from "./plans";
import { buildArgs, envAllowlist, spawnProcess, TOOLS_ENABLED, type CmdProcess } from "./spawn";
import { findTranscriptPath, tailTranscript, transcriptPathFor } from "./transcript";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";

export const CMD_CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: true,
  subagents: true,
  // Print mode has no image flag; the connector stages the files and names
  // their paths in the prompt instead (decision W10).
  images: true,
  resume: true,
  fork: true,
};

/** The opaque `sessionRef` the engine persists between process spawns. */
export interface CmdSessionRef {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
  /**
   * Newest transcript message already emitted — `meta.messageId` or the line
   * id. On resume the tailer picks up right after it: lines written while the
   * server was down get emitted, earlier ones don't repeat.
   */
  readonly lastMessageId: string | null;
}

/**
 * The live process plus two latches: `turnDone` flips when the turn's
 * completion event has been emitted — turn.completed lands on run_end while
 * the child is still a few milliseconds from reaping — and `settled` flips
 * when every post-exit side effect (onExit events, the sessionRef persist,
 * fiber teardown) has landed. A send arriving between them waits the pump
 * out instead of reporting a turn that no longer exists.
 */
interface ActiveProcess {
  readonly proc: CmdProcess;
  readonly turnDone: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
  /** Spawned with `--permission-mode plan` — its run may leave a plan file behind. */
  readonly plan: boolean;
  /**
   * When the process was spawned. Print mode does not record its plan in
   * `plans-index.json`, so a file's mtime against this is how a plan written by
   * *this* turn is told from one sitting in the directory since last month.
   */
  readonly startedAt: number;
  /**
   * The user asked for this one to stop. It decides how the exit reads: a
   * child we killed ourselves settles the turn `interrupted`, the same signal
   * death unasked-for is a crash the supervisor resumes from.
   */
  readonly interrupted: Ref.Ref<boolean>;
}

/**
 * Exit codes that mean "the process died on a signal": `spawnProcess` reports
 * `-1` when node hands it a null code, and 128+n is what a shell would have
 * reported for SIGKILL and SIGTERM.
 */
const SIGNAL_DEATHS = new Set([-1, 137, 143]);

export interface CmdSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binaryPath?: string;
  readonly extraEnv?: Record<string, string>;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  readonly sessionRef?: CmdSessionRef;
  /**
   * Home directory override for transcript resolution. The harness resolves
   * `~/.commandcode` against `HOME` alone (spec 5.1), so a test that points the
   * child's `HOME` aside passes the same directory here.
   */
  readonly home?: string;
}

export const makeCmdSession = (
  options: CmdSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue();
    const settingsRef = yield* Ref.make(options.settings);
    const processRef = yield* Ref.make<ActiveProcess | null>(null);
    const sessionRef = yield* Ref.make<CmdSessionRef | null>(options.sessionRef ?? null);
    /** Plan files already proposed this session — a settled plan turn must not re-propose. */
    const proposedPlans = yield* Ref.make(new Set<string>());
    /**
     * One send at a time through the check→settle→spawn→install sequence:
     * without the permit, two concurrent sends can both observe `null` in
     * processRef and each spawn a turn.
     */
    const sendMutex = yield* Semaphore.make(1);
    const closedRef = yield* Ref.make(false);
    const scope = yield* Effect.scope;

    // The harness slugs its *resolved* cwd into the transcript path — a
    // workspace reached through a symlink (macOS /tmp → /private/tmp) writes
    // under the physical path, so the tailer must watch that one.
    const transcriptRoot = yield* Effect.sync(() => {
      try {
        return NodeFS.realpathSync(options.workspaceRoot);
      } catch {
        return options.workspaceRoot;
      }
    });

    /**
     * The transcript path the sessionRef carries. `findTranscriptPath` answers
     * with the directory the harness really used; before the file exists there
     * is nothing to find, so the slug guess stands in until it does — the ref
     * is rewritten on every event that touches it, and the last write wins.
     */
    const transcriptPathOf = (sessionId: string): string =>
      findTranscriptPath(transcriptRoot, sessionId, options.home) ??
      transcriptPathFor(transcriptRoot, sessionId, options.home);

    // One translator for the session's whole life: dedupe keys (tool_use.id,
    // messageId) must survive across the one-process-per-turn boundary or the
    // run_end reconcile would re-emit history on every turn.
    const translator = makeTranslator({
      connectorInstanceId: options.instanceId,
      capabilities: CMD_CAPABILITIES,
      resumeAfterMessageId: options.sessionRef?.lastMessageId ?? null,
    });

    const emit = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* queue.offer({
          eventId: makeEventId(),
          connectorInstanceId: options.instanceId,
          threadId: options.threadId,
          createdAt: new Date(millis).toISOString(),
          ...pending,
        } as RuntimeEvent);
      });

    /**
     * The translator's `session.started` carries `{sessionId, null, null}` —
     * only this layer knows the workspace — so the full ref the engine
     * persists is filled in here on the way out.
     */
    const enrich = (pending: PendingRuntimeEvent): PendingRuntimeEvent => {
      if (pending.type !== "session.started") {
        return pending;
      }
      const ref = pending.payload.sessionRef as { sessionId?: unknown } | null;
      const sessionId = ref?.sessionId;
      if (typeof sessionId !== "string") {
        return pending;
      }
      return {
        ...pending,
        payload: {
          ...pending.payload,
          sessionRef: {
            sessionId,
            transcriptPath: transcriptPathOf(sessionId),
            cwd: options.workspaceRoot,
            lastMessageId: translator.lastMessageId,
          } satisfies CmdSessionRef,
        },
      };
    };

    const emitAll = (pendings: ReadonlyArray<PendingRuntimeEvent>): Effect.Effect<void> =>
      Effect.forEach(pendings, (pending) => emit(enrich(pending)), { discard: true });

    /**
     * Reads the transcript to the end and folds whatever the tailer has not
     * reached yet, before the turn is allowed to settle.
     *
     * The harness's last transcript flush lands *with* `run_end`, not before
     * it, and the tailer is a poller — so the assistant line that carries
     * `usage.costUsd` reliably arrived after `turn.completed`, which is after
     * the engine has stopped tagging events with that turn. The turn's price
     * was therefore never reported.
     *
     * Re-reading what the tailer already delivered costs nothing: messages
     * dedupe on `meta.messageId` and priced lines on the same id, so a line
     * seen twice emits nothing and charges nothing.
     */
    const drainTranscript: Effect.Effect<void> = Effect.gen(function* () {
      const sessionId = translator.sessionId;
      if (sessionId === null) {
        return;
      }
      const lines = yield* Effect.sync(() => {
        const path = findTranscriptPath(transcriptRoot, sessionId, options.home);
        if (path === null) {
          return [] as ReadonlyArray<string>;
        }
        try {
          return NodeFS.readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0);
        } catch {
          return [] as ReadonlyArray<string>;
        }
      });
      for (const line of lines) {
        const pendings = yield* Effect.try({
          try: () => translator.onTranscriptLine(JSON.parse(line)),
          catch: (): ReadonlyArray<PendingRuntimeEvent> => [],
        }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PendingRuntimeEvent>)));
        yield* emitAll(pendings);
      }
    });

    /**
     * A plan-mode turn that just ended may have left a plan file behind:
     * `plans-index.json` matches it to this session by `sessionId`, and the
     * newest matching entry is read and proposed. Emitted while the turn is
     * still open — after `turn.completed` the engine no longer tags events
     * with its turnId — and each plan file is proposed once per session.
     */
    const emitPlanProposal = (active: ActiveProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!active.plan) {
          return;
        }
        const sessionId = translator.sessionId;
        if (sessionId === null) {
          return;
        }
        const proposal = yield* Effect.sync(() =>
          readPlanProposal(sessionId, options.home, active.startedAt),
        );
        if (proposal === null) {
          return;
        }
        // path + revision: an unchanged index entry is not proposed twice,
        // while a revised plan file is.
        const key = `${proposal.planPath}#${proposal.updatedAt}`;
        const fresh = yield* Ref.modify(proposedPlans, (seen): readonly [boolean, Set<string>] =>
          seen.has(key) ? [false, seen] : [true, new Set(seen).add(key)],
        );
        if (!fresh) {
          return;
        }
        yield* emit({
          type: "turn.plan.proposed",
          payload: {
            turnId: makeTurnId(),
            planMarkdown: proposal.markdown,
            planPath: proposal.planPath,
          },
        });
      });

    /** Everything the PreToolUse bridge needs, kept out of this file. */
    const hookAnswers = yield* makeHookAnswerer({
      threadId: options.threadId,
      services: options.services,
      settings: Ref.get(settingsRef),
      emit,
    });

    // ── session start: hook script + project config + handler ──

    const warn = (message: string): Effect.Effect<void> =>
      options.services.logger
        .log("warn", message)
        .pipe(Effect.andThen(emit({ type: "session.warning", payload: { message } })));

    const hookPath = yield* ensureHookScript().pipe(
      Effect.catch((error) =>
        warn(`could not write the hook script: ${String(error)}`).pipe(Effect.as(null)),
      ),
    );
    // What the two installs below wrote, so close() can put both files back.
    const installedHooks = yield* Ref.make<InstalledFile | null>(null);
    const installedMcp = yield* Ref.make<InstalledFile | null>(null);
    if (hookPath !== null) {
      // `null` is the install standing down on a file it cannot parse;
      // `undefined` is the write itself failing. Both run the session without
      // the hook, and both say so — the approval gate is off either way.
      const written = yield* installProjectHooks(options.workspaceRoot, hookPath).pipe(
        Effect.catch((error) =>
          warn(`could not install project hooks: ${String(error)}`).pipe(Effect.as(undefined)),
        ),
      );
      if (written === null) {
        yield* warn(
          ".commandcode/settings.local.json is not valid JSON — left it untouched, so tool calls are not gated by OpenAde",
        );
      }
      yield* Ref.set(installedHooks, written ?? null);
    }
    const mcp = yield* options.services
      .mcpEndpoint(options.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    // An empty url is how a server without an MCP endpoint says "nothing to
    // configure": skip writing mcp.json entirely.
    if (mcp !== null && mcp.url !== "") {
      const written = yield* upsertMcpEntry(transcriptRoot, { url: mcp.url }, options.home).pipe(
        Effect.catch((error) =>
          warn(`could not write mcp.json: ${String(error)}`).pipe(Effect.as(undefined)),
        ),
      );
      if (written === null) {
        yield* warn(
          "the project's mcp.json is not valid JSON — left it untouched, so OpenAde's MCP tools are unavailable this session",
        );
      }
      yield* Ref.set(installedMcp, written ?? null);
    }
    if (options.services.registerHookHandler !== undefined) {
      yield* options.services.registerHookHandler(options.threadId, hookAnswers.onHookPost);
    }

    /** Wires one spawned process's three sources into the translator. */
    const pump = Effect.fn("CmdSession.pump")(function* (active: ActiveProcess) {
      const proc = active.proc;
      const splitter = makeLineSplitter();
      const transcriptFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);

      // run_start carries the sessionId — that is the first moment the
      // transcript path exists, so the tailer starts there, not at spawn.
      const startTailer = (sessionId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if ((yield* Ref.get(transcriptFiber)) !== null) return;
          // Located by session id on every poll rather than by the slug: the
          // harness's project-directory naming is not the one `slugFor`
          // guesses, and the file only appears seconds into the turn.
          const locate = (): string | null =>
            findTranscriptPath(transcriptRoot, sessionId, options.home);
          const fiber = yield* tailTranscript(locate, {
            // A resumed session's marker: start right after the last message
            // a previous runtime emitted — lines written while the server was
            // down still arrive, earlier ones don't repeat.
            afterMessageId: options.sessionRef?.lastMessageId ?? undefined,
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.flatMap((tailer) =>
              Stream.runForEach(tailer.lines, (line) =>
                Effect.try({
                  try: () => translator.onTranscriptLine(JSON.parse(line)),
                  catch: (): ReadonlyArray<PendingRuntimeEvent> => [
                    {
                      type: "event.unmapped" as const,
                      payload: {},
                      raw: { source: "cmd.transcript", payload: line },
                    },
                  ],
                }).pipe(Effect.flatMap(emitAll)),
              ),
            ),
            Effect.catch(() => Effect.void),
            Effect.forkIn(scope),
          );
          yield* Ref.set(transcriptFiber, fiber);
        });

      // stderr carries "session: <id>" plus progress; drain it so the pipe
      // never back-pressures, and learn the id if run_start has not said it.
      const stderrFiber = yield* Stream.runForEach(proc.stderr, (chunk) =>
        Effect.gen(function* () {
          const match = /^session:\s*(\S+)/m.exec(chunk);
          if (match?.[1] !== undefined && translator.sessionId === null) {
            yield* startTailer(match[1]);
          }
          yield* options.services.logger.log("debug", `cmd stderr: ${chunk.trimEnd()}`);
        }),
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      );

      /**
       * Emits one translated event with the bookkeeping that hangs off it: a
       * plan proposal must go out before its turn.completed (once the turn
       * settles, the engine stops tagging events with its turnId), and
       * turnDone flips before the completion event so a consumer that sees it
       * and immediately sends cannot slip between the two steps.
       */
      const emitPrepared = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const prepared = enrich(pending);
          if (prepared.type === "turn.completed") {
            yield* drainTranscript;
            yield* emitPlanProposal(active);
            yield* Deferred.succeed(active.turnDone, undefined);
          }
          yield* emit(prepared);
          if (prepared.type === "session.started") {
            const ref = prepared.payload.sessionRef as { sessionId?: string };
            if (typeof ref.sessionId === "string") {
              // Persist the ref the moment the harness names the session —
              // not just at process exit — so a `sessionRef()` read during or
              // right after the turn already resolves.
              yield* Ref.set(sessionRef, {
                sessionId: ref.sessionId,
                transcriptPath: transcriptPathOf(ref.sessionId),
                cwd: options.workspaceRoot,
                lastMessageId: translator.lastMessageId,
              });
              yield* startTailer(ref.sessionId);
            }
          }
        });

      /** One complete stdout line → its events. */
      const handleLine = (line: string): Effect.Effect<void> => {
        const frame = parseFrame(line);
        const pendings: ReadonlyArray<PendingRuntimeEvent> =
          "line" in frame
            ? [
                {
                  type: "event.unmapped" as const,
                  payload: {},
                  raw: { source: "cmd.ndjson", payload: frame },
                },
              ]
            : translator.onFrame(frame);
        return Effect.forEach(pendings, emitPrepared, { discard: true });
      };

      const stdoutFiber = yield* Stream.runForEach(proc.stdout, (chunk) =>
        Effect.gen(function* () {
          const pushed = splitter.push(chunk);
          yield* Effect.forEach(pushed.lines, handleLine, { discard: true });
          if (pushed.overflow !== null) {
            // The tail exceeded the line cap and was dropped — say so rather
            // than lose the bytes silently.
            yield* emitPrepared({
              type: "event.unmapped",
              payload: {},
              raw: { source: "cmd.ndjson", payload: pushed.overflow },
            });
          }
        }),
      ).pipe(
        // EOF: the final frame may be missing its trailing newline — flush
        // the split tail rather than drop the run's last word.
        Effect.andThen(() => {
          const tail = splitter.flush();
          return tail === null ? Effect.void : handleLine(tail);
        }),
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      );

      const exitCode = yield* proc.exitCode;
      // Exit resolves before the pipes finish draining — let the stdout
      // reader run out the buffered chunks and the unterminated tail (EOF
      // flush) before teardown. A grandchild that inherited the pipe holds it
      // open forever; the timeout keeps that from wedging the pump.
      yield* Effect.raceFirst(Fiber.await(stdoutFiber), Effect.sleep("2 seconds"));
      if (translator.sessionId !== null) {
        yield* Ref.set(sessionRef, {
          sessionId: translator.sessionId,
          transcriptPath: transcriptPathOf(translator.sessionId),
          cwd: options.workspaceRoot,
          lastMessageId: translator.lastMessageId,
        });
      }
      yield* hookAnswers.releasePending;
      // A child we killed ourselves reads as an interrupt whatever signal
      // finished it off: the escalation ladder ends in SIGKILL, which node
      // reports as a null code (-1), and that must not settle the turn
      // "error" or look like a crash to the supervisor.
      const interrupted = yield* Ref.get(active.interrupted);
      const code = interrupted && exitCode !== 130 ? 130 : exitCode;
      // Whatever onExit emits, no turn can still be in progress under a dead
      // process — flip before the emits so a consumer that sees the
      // completion and immediately sends cannot slip between them.
      yield* Deferred.succeed(active.turnDone, undefined);
      yield* Effect.forEach(translator.onExit(code), emitPrepared, { discard: true });
      yield* Ref.set(processRef, null);
      yield* Fiber.interrupt(stdoutFiber);
      yield* Fiber.interrupt(stderrFiber);
      const tailer = yield* Ref.get(transcriptFiber);
      if (tailer !== null) yield* Fiber.interrupt(tailer);
      // A signal death nobody asked for is a crash: without a `session.ended`
      // the stream stays open, the supervisor never hears about it and the
      // thread is stuck on a turn that will never finish. Ending it here is
      // what lets the supervisor resume from the persisted sessionRef.
      if (!interrupted && SIGNAL_DEATHS.has(exitCode)) {
        yield* endSession("crashed", exitCode);
      }
      // The slot is free only now: bookkeeping — onExit events, the sessionRef
      // persist — is what a follow-up send must wait out, not just the exit.
      yield* Deferred.succeed(active.settled, undefined);
    });

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      sendMutex
        .withPermit(
          Effect.gen(function* () {
            if (yield* Ref.get(closedRef)) {
              return yield* new SessionClosed({ threadId: options.threadId });
            }
            const previous = yield* Ref.get(processRef);
            if (previous !== null) {
              if (!(yield* Deferred.isDone(previous.turnDone))) {
                // Caller queues the next turn; print mode runs one turn per process.
                return yield* new TurnInProgress({
                  threadId: options.threadId,
                  activeTurnId: null,
                });
              }
              // turn.completed already left but the child is mid-reap — wait
              // the pump out rather than report a turn that no longer exists.
              yield* Deferred.await(previous.settled);
            }
            const settings = yield* Ref.get(settingsRef);
            const prior = yield* Ref.get(sessionRef);
            const hook = yield* options.services.hookEndpoint(options.threadId);
            // The bearer goes to disk, not into the environment: Command Code
            // strips secret-shaped variable names out of a hook's env, which
            // silently turned the whole approval gate off (see hookScript.ts).
            const ticket = hookTicketPath(options.threadId);
            yield* writeHookTicket(ticket, hook.bearer).pipe(
              Effect.catch((error) => warn(`could not write the hook ticket: ${String(error)}`)),
            );
            const mentioned = turn.mentions.map((m) => `@${m}`);
            // Print mode has no image flag: the files go under
            // `<attachmentsDir>/<threadId>/`, that directory joins the run's
            // scope, and the prompt names the absolute paths (decision W10).
            const attached = yield* Effect.promise(() =>
              stageTurnAttachments({
                attachmentsDir: options.services.attachmentsDir,
                threadId: options.threadId,
                attachments: turn.attachments,
              }),
            );
            for (const message of attached.warnings) {
              yield* warn(message);
            }
            const prompt = [turn.text, ...mentioned, ...attached.promptLines]
              .filter((part) => part.length > 0)
              .join("\n\n");
            const plan = settings.interactionMode === "plan";
            const args = buildArgs({
              prompt,
              model: settings.model,
              ...(settings.effort === undefined ? {} : { effort: settings.effort }),
              ...(prior === null ? {} : { sessionId: prior.sessionId }),
              // `--yolo` on every turn, plan mode included. Print mode refuses
              // writes and shell without it whatever a hook answered
              // (`fixtures/cmd/shell-allow/`), and in plan mode that refusal
              // extends to the plan file the model is told to write, so a plan
              // turn without it produces no plan at all
              // (`fixtures/cmd/plan-no-yolo/`). It costs no gate: plan mode
              // skips PreToolUse entirely either way, and the plan ladder still
              // declines to touch the workspace (`fixtures/cmd/plan-guard/`).
              yolo: true,
              ...(plan ? { permissionMode: "plan" as const } : {}),
              ...(attached.addDirs.length === 0 ? {} : { addDir: attached.addDirs }),
              toolsEnable: TOOLS_ENABLED,
            });
            const proc = yield* spawnProcess({
              binaryPath: options.binaryPath ?? "cmd",
              args,
              cwd: options.workspaceRoot,
              env: envAllowlist(process.env, {
                OPENADE_HOOK_URL: hook.url,
                // A path, not a secret — see the ticket comment above.
                OPENADE_HOOK_TICKET_FILE: ticket,
                OPENADE_THREAD_ID: options.threadId,
                ...(mcp === null ? {} : { OPENADE_MCP_TOKEN: mcp.bearer }),
                ...options.extraEnv,
              }),
            }).pipe(Effect.provideService(Scope.Scope, scope));
            const active: ActiveProcess = {
              proc,
              turnDone: yield* Deferred.make<void>(),
              settled: yield* Deferred.make<void>(),
              plan,
              startedAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
              interrupted: yield* Ref.make(false),
            };
            yield* Ref.set(processRef, active);
            yield* pump(active).pipe(Effect.forkIn(scope));
          }),
        )
        .pipe(
          Effect.mapError((error): ConnectorError =>
            error instanceof SessionClosed || error instanceof TurnInProgress
              ? error
              : new SpawnFailed({
                  kind: "cmd",
                  instanceId: options.instanceId,
                  message: error instanceof Error ? error.message : String(error),
                }),
          ),
        );

    /**
     * The one way a session ends: `stopped` when the caller closed it,
     * `crashed` when the child died on a signal nobody asked for. Both revoke
     * the bearer, put the project config back and end the stream — the
     * supervisor only gets to resume when the stream carries `crashed`.
     */
    const endSession = (reason: "stopped" | "crashed", exitCode?: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) {
          return;
        }
        yield* Ref.set(closedRef, true);
        // The session's processes are gone once this returns — revoke the hook
        // bearer with them rather than leave it valid until the scope ends.
        if (options.services.unregisterHookHandler !== undefined) {
          yield* options.services
            .unregisterHookHandler(options.threadId)
            .pipe(Effect.catch(() => Effect.void));
        }
        const active = yield* Ref.get(processRef);
        if (active !== null) {
          yield* active.proc.kill;
        }
        yield* hookAnswers.releasePending;
        // The project is the user's, not ours: the hook block and the MCP entry
        // go out with the session that put them there. Both reverts no-op when
        // the file has changed since or another session still holds it.
        const hooks = yield* Ref.get(installedHooks);
        if (hooks !== null && hookPath !== null) {
          yield* uninstallProjectHooks(options.workspaceRoot, hookPath, hooks).pipe(
            Effect.catch(() => Effect.void),
          );
        }
        const mcpFile = yield* Ref.get(installedMcp);
        if (mcpFile !== null) {
          yield* removeMcpEntry(transcriptRoot, options.home, mcpFile).pipe(
            Effect.catch(() => Effect.void),
          );
        }
        // The bearer outlives nothing: the session that minted it is over.
        yield* removeHookTicket(hookTicketPath(options.threadId)).pipe(
          Effect.catch(() => Effect.void),
        );
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* queue.end;
      });

    const close: Effect.Effect<void> = endSession("stopped");

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (options.services.unregisterHookHandler !== undefined) {
          yield* options.services
            .unregisterHookHandler(options.threadId)
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* close;
      }),
    );

    return {
      events: queue.events,
      send,
      // Spec section 8: SIGINT to the process group, SIGKILL after 5s, then a
      // descendant sweep. A bare SIGINT leaves a child that ignores it — or a
      // shell_command grandchild holding the pipe — running forever, and with
      // it a turn that never settles and a thread that can never send again.
      interrupt: () =>
        Ref.get(processRef).pipe(
          Effect.flatMap((active) =>
            active === null
              ? Effect.void
              : Ref.set(active.interrupted, true).pipe(Effect.andThen(active.proc.kill)),
          ),
        ),
      respondToRequest: hookAnswers.respondToRequest,
      respondToUserInput: hookAnswers.respondToUserInput,
      respondToPlan: () => Effect.void, // plan-mode turns answer through send()
      updateSettings: (patch) => Ref.update(settingsRef, (settings) => ({ ...settings, ...patch })),
      sessionRef: () => Ref.get(sessionRef),
      close: () => close,
    };
  });
