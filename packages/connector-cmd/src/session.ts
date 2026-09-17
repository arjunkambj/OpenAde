/**
 * One Command Code session for one thread.
 *
 * Print mode is one turn per process (spec 5.1): `send` spawns
 * `cmd -p "<prompt>" --session <sessionId> --yolo` and the harness resumes its
 * own persisted session. `--yolo` keeps the CLI from ever blocking on its own
 * prompts — approvals flow through our PreToolUse hook instead, which the
 * HookBridge route answers. `interactionMode: "plan"` swaps `--yolo` for
 * `--permission-mode plan`.
 *
 * Three sources feed the event stream: NDJSON frames on stdout, the session
 * transcript the harness appends on disk, and hook posts. The translator —
 * one per session, not per process — dedupes the overlap across turns; the
 * turn-scoped wrapper settles turns.
 */
import * as NodeFS from "node:fs";
import type { ApprovalDecision, ApprovalKind } from "@OpenAde/contracts/enums";
import type { ConnectorInstanceId, RequestId, ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import type {
  ApprovalRequest,
  ConnectorCapabilities,
  RuntimeEvent,
  UserQuestion,
  UserQuestionAnswer,
} from "@OpenAde/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@OpenAde/connector-sdk/definition";
import { SessionClosed, SpawnFailed, TurnInProgress } from "@OpenAde/connector-sdk/definition";
import { makeBoundedEventQueue, type SessionHandle } from "@OpenAde/connector-sdk/sessionHandle";
import { makeEventId, makeRequestId } from "@OpenAde/contracts/ids";

import { installProjectHooks, upsertMcpEntry } from "./config";
import { ensureHookScript } from "./hookScript";
import { makeLineSplitter, parseFrame } from "./ndjson";
import { buildArgs, envAllowlist, spawnProcess, type CmdProcess } from "./spawn";
import { tailTranscript, transcriptPathFor } from "./transcript";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";

export const CMD_CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: true,
  subagents: true,
  images: false,
  resume: true,
  fork: true,
};

/** The opaque `sessionRef` the engine persists between process spawns. */
export interface CmdSessionRef {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

interface PendingApproval {
  readonly released: Deferred.Deferred<ApprovalDecision>;
}

interface PendingUserInput {
  readonly released: Deferred.Deferred<ReadonlyArray<UserQuestionAnswer>>;
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
}

export interface CmdSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binaryPath?: string;
  readonly extraEnv?: Record<string, string>;
  readonly defaultModel?: string;
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

const approvalKindFor = (toolName: string): ApprovalKind => {
  if (toolName === "shell_command") return "command";
  if (toolName === "edit_file" || toolName === "write_file") return "file_write";
  if (toolName.startsWith("read_") || toolName === "glob" || toolName === "grep")
    return "file_read";
  if (toolName.startsWith("mcp__")) return "mcp_tool";
  if (toolName === "web_search" || toolName === "web_fetch") return "web";
  return "other";
};

export const makeCmdSession = (
  options: CmdSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue();
    const settingsRef = yield* Ref.make(options.settings);
    const processRef = yield* Ref.make<ActiveProcess | null>(null);
    const sessionRef = yield* Ref.make<CmdSessionRef | null>(options.sessionRef ?? null);
    const pendingApprovals = yield* Ref.make(new Map<RequestId, PendingApproval>());
    const pendingUserInputs = yield* Ref.make(new Map<RequestId, PendingUserInput>());
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

    // One translator for the session's whole life: dedupe keys (tool_use.id,
    // messageId) must survive across the one-process-per-turn boundary or the
    // run_end reconcile would re-emit history on every turn.
    const translator = makeTranslator({
      connectorInstanceId: options.instanceId,
      capabilities: CMD_CAPABILITIES,
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
            transcriptPath: transcriptPathFor(transcriptRoot, sessionId, options.home),
            cwd: options.workspaceRoot,
          } satisfies CmdSessionRef,
        },
      };
    };

    const emitAll = (pendings: ReadonlyArray<PendingRuntimeEvent>): Effect.Effect<void> =>
      Effect.forEach(pendings, (pending) => emit(enrich(pending)), { discard: true });

    /**
     * A dead process leaves hook posts parked — every outstanding approval is
     * released with `deny` (and `user-input` with empty answers) so the bridge
     * replies instead of hanging to the 590s ceiling.
     */
    const releasePending = Effect.gen(function* () {
      const approvals = yield* Ref.getAndSet(pendingApprovals, new Map());
      for (const [requestId, pending] of approvals) {
        yield* Deferred.succeed(pending.released, "deny" as const);
        yield* emit({
          type: "request.resolved",
          requestId,
          payload: { requestId, decision: "deny" },
        });
      }
      const inputs = yield* Ref.getAndSet(pendingUserInputs, new Map());
      for (const [requestId, pending] of inputs) {
        yield* Deferred.succeed(pending.released, []);
        yield* emit({ type: "user-input.resolved", requestId, payload: { requestId } });
      }
    });

    /**
     * Answers a PreToolUse post for this session: asks the permission engine,
     * and on "prompt" opens a request and parks until `respondToRequest`
     * resolves it. The hook script turns the reply into `permissionDecision`.
     */
    const onHookPost = (body: unknown): Effect.Effect<unknown> =>
      Effect.gen(function* () {
        const record = body as {
          readonly tool_use_id?: string;
          readonly tool_name?: string;
          readonly tool_input?: unknown;
          readonly hook_event_name?: string;
        };
        const toolName = record.tool_name ?? "unknown";
        // The harness's tool_use_id is not a UUIDv7 — the wire ids are ours.
        const requestId = makeRequestId();

        if (record.tool_name === "ask_user_question") {
          const questions = (record.tool_input as { questions?: unknown })?.questions;
          const released = yield* Deferred.make<ReadonlyArray<UserQuestionAnswer>>();
          yield* Ref.update(pendingUserInputs, (map) => new Map(map).set(requestId, { released }));
          yield* emit({
            type: "user-input.requested",
            requestId,
            payload: {
              requestId,
              questions: (Array.isArray(questions) ? questions : []) as ReadonlyArray<UserQuestion>,
            },
          });
          const answers = yield* Deferred.await(released);
          yield* Ref.update(pendingUserInputs, (map) => {
            const next = new Map(map);
            next.delete(requestId);
            return next;
          });
          yield* emit({ type: "user-input.resolved", requestId, payload: { requestId } });
          // Deny the tool and hand the answers back as the reason — the
          // harness reads them as context instead of asking interactively.
          return {
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: JSON.stringify(answers),
            },
          };
        }

        const settings = yield* Ref.get(settingsRef);
        const request: ApprovalRequest = {
          requestId,
          kind: approvalKindFor(toolName),
          toolName,
          input: record.tool_input ?? {},
          description: toolName,
        };
        const decision = yield* options.services.permissions.decide({
          request,
          threadId: options.threadId,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
        });
        if (decision === "allow") {
          return { hookSpecificOutput: { permissionDecision: "allow" } };
        }
        if (decision === "deny") {
          return {
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: "denied by OpenAde permission rules",
            },
          };
        }
        // prompt → the user decides via thread.approval.respond.
        const released = yield* Deferred.make<ApprovalDecision>();
        yield* Ref.update(pendingApprovals, (map) => new Map(map).set(requestId, { released }));
        yield* emit({ type: "request.opened", requestId, payload: { request } });
        const answer = yield* Deferred.await(released);
        yield* Ref.update(pendingApprovals, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
        yield* emit({
          type: "request.resolved",
          requestId,
          payload: { requestId, decision: answer },
        });
        return {
          hookSpecificOutput: {
            permissionDecision: answer === "deny" ? "deny" : "allow",
            permissionDecisionReason: `decided ${answer} via OpenAde`,
          },
        };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            // A hook error must never let a tool run — deny is the safe answer.
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: "hook bridge error",
            },
          }),
        ),
      );

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
    if (hookPath !== null) {
      yield* installProjectHooks(options.workspaceRoot, hookPath).pipe(
        Effect.catch((error) => warn(`could not install project hooks: ${String(error)}`)),
      );
    }
    const mcp = yield* options.services
      .mcpEndpoint(options.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    // An empty url is how a server without an MCP endpoint (none yet — W6)
    // says "nothing to configure": skip writing .mcp.json entirely.
    if (mcp !== null && mcp.url !== "") {
      yield* upsertMcpEntry(options.workspaceRoot, { url: mcp.url }).pipe(
        Effect.catch((error) => warn(`could not write .mcp.json: ${String(error)}`)),
      );
    }
    if (options.services.registerHookHandler !== undefined) {
      yield* options.services.registerHookHandler(options.threadId, onHookPost);
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
          const path = transcriptPathFor(transcriptRoot, sessionId, options.home);
          const fiber = yield* tailTranscript(path).pipe(
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

      const stdoutFiber = yield* Stream.runForEach(proc.stdout, (chunk) =>
        Effect.forEach(
          splitter
            .push(chunk)
            .map(parseFrame)
            .flatMap((frame): ReadonlyArray<PendingRuntimeEvent> =>
              "line" in frame
                ? [
                    {
                      type: "event.unmapped" as const,
                      payload: {},
                      raw: { source: "cmd.ndjson", payload: frame },
                    },
                  ]
                : translator.onFrame(frame),
            ),
          (pending) =>
            Effect.gen(function* () {
              const prepared = enrich(pending);
              // Flip before the emit: a consumer that sees turn.completed and
              // immediately sends must not slip between the two steps.
              if (prepared.type === "turn.completed") {
                yield* Deferred.succeed(active.turnDone, undefined);
              }
              yield* emit(prepared);
              if (prepared.type === "session.started") {
                const ref = prepared.payload.sessionRef as { sessionId?: string };
                if (typeof ref.sessionId === "string") {
                  yield* startTailer(ref.sessionId);
                }
              }
            }),
          { discard: true },
        ),
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      );

      const exitCode = yield* proc.exitCode;
      if (translator.sessionId !== null) {
        yield* Ref.set(sessionRef, {
          sessionId: translator.sessionId,
          transcriptPath: transcriptPathFor(transcriptRoot, translator.sessionId, options.home),
          cwd: options.workspaceRoot,
        });
      }
      yield* releasePending;
      // Whatever onExit emits, no turn can still be in progress under a dead
      // process — flip before emitAll so a consumer that sees the completion
      // and immediately sends cannot slip between them.
      yield* Deferred.succeed(active.turnDone, undefined);
      yield* emitAll(translator.onExit(exitCode));
      yield* Ref.set(processRef, null);
      yield* Fiber.interrupt(stdoutFiber);
      yield* Fiber.interrupt(stderrFiber);
      const tailer = yield* Ref.get(transcriptFiber);
      if (tailer !== null) yield* Fiber.interrupt(tailer);
      // The slot is free only now: bookkeeping — onExit events, the sessionRef
      // persist — is what a follow-up send must wait out, not just the exit.
      yield* Deferred.succeed(active.settled, undefined);
    });

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
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
          // turn.completed already left but the child is mid-reap — wait the
          // pump out rather than report a turn that no longer exists.
          yield* Deferred.await(previous.settled);
        }
        const settings = yield* Ref.get(settingsRef);
        const prior = yield* Ref.get(sessionRef);
        const hook = yield* options.services.hookEndpoint(options.threadId);
        const mentioned = turn.mentions.map((m) => `@${m}`);
        const attached = turn.attachments.map((a) => `Attachment: ${a.path}`);
        const prompt = [turn.text, ...mentioned, ...attached]
          .filter((part) => part.length > 0)
          .join("\n\n");
        const plan = settings.interactionMode === "plan";
        const args = buildArgs({
          prompt,
          model: settings.model === "" ? options.defaultModel : settings.model,
          ...(settings.effort === undefined ? {} : { effort: settings.effort }),
          ...(prior === null ? {} : { sessionId: prior.sessionId }),
          yolo: !plan, // plan mode replaces --yolo (spec section 8)
          ...(plan ? { permissionMode: "plan" as const } : {}),
        });
        const proc = yield* spawnProcess({
          binaryPath: options.binaryPath ?? "cmd",
          args,
          cwd: options.workspaceRoot,
          env: envAllowlist(process.env, {
            OPENADE_HOOK_URL: hook.url,
            OPENADE_HOOK_TOKEN: hook.bearer,
            OPENADE_THREAD_ID: options.threadId,
            ...(mcp === null ? {} : { OPENADE_MCP_TOKEN: mcp.bearer }),
            ...options.extraEnv,
          }),
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const active: ActiveProcess = {
          proc,
          turnDone: yield* Deferred.make<void>(),
          settled: yield* Deferred.make<void>(),
        };
        yield* Ref.set(processRef, active);
        yield* pump(active).pipe(Effect.forkIn(scope));
      }).pipe(
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

    const close: Effect.Effect<void> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return;
      }
      yield* Ref.set(closedRef, true);
      // The session's processes are gone once close returns — revoke the hook
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
      yield* releasePending;
      yield* emit({ type: "session.ended", payload: { reason: "stopped" } });
      yield* queue.end;
    });

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
      interrupt: () =>
        Ref.get(processRef).pipe(
          Effect.flatMap((active) =>
            active === null ? Effect.void : active.proc.signal("SIGINT"),
          ),
        ),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovals)).get(requestId);
          if (pending === undefined) return;
          yield* Deferred.succeed(pending.released, decision);
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputs)).get(requestId);
          if (pending === undefined) return;
          yield* Deferred.succeed(pending.released, answers);
        }),
      respondToPlan: () => Effect.void, // plan-mode turns answer through send()
      updateSettings: (patch) => Ref.update(settingsRef, (settings) => ({ ...settings, ...patch })),
      sessionRef: () => Ref.get(sessionRef),
      close: () => close,
      // Direct access for tests without a hook bridge (the bridge normally
      // routes through registerHookHandler above).
      __hookHandler: onHookPost,
    } as SessionHandle & { readonly __hookHandler: typeof onHookPost };
  });
