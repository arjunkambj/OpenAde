/**
 * One Claude Code session for one thread.
 *
 * Unlike Command Code's one-process-per-turn print mode, one CLI process
 * serves the whole session: the SDK's `query()` runs in streaming-input mode,
 * fed by the session's input queue (`inputQueue.ts`), and every turn is one
 * more user message written to the same process. The session:
 *
 * 1. starts the query and waits for the CLI's initialize handshake, so a CLI
 *    that cannot start — or refuses the session id it was asked to resume —
 *    fails `startSession` with `SpawnFailed` instead of a thread that never
 *    answers;
 * 2. announces itself with `session.started` before any work, its ref naming
 *    the session id it minted (the SDK's `sessionId`) or resumed;
 * 3. translates every SDK message the query yields (`translate/translator.ts`)
 *    on one consumer fiber;
 * 4. gates every tool call through OpenAde's permission ladder
 *    (`toolGate.ts`), from the first message on;
 * 5. closes by releasing open cards, ending the input, closing the query,
 *    stopping the CLI's process group and proving it gone (`spawn.ts`).
 *
 * The CLI stopping on its own — the stream ending or failing while the session
 * is open — is a crash: a fatal `runtime.error` naming the CLI's last stderr,
 * then `session.ended { reason: "crashed" }`, which the supervisor resumes from.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeApprovalGate } from "@OpenAde/connector-sdk/approvalGate";
import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@OpenAde/connector-sdk/definition";
import { SessionClosed, SpawnFailed, TurnInProgress } from "@OpenAde/connector-sdk/definition";
import { makeBoundedEventQueue, type SessionHandle } from "@OpenAde/connector-sdk/sessionHandle";
import type { ConnectorInstanceId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import { makeEventId, makeTurnId } from "@OpenAde/contracts/ids";
import type { ThreadSettings, ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ResolvedBinary } from "./binary";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { makeInputQueue } from "./inputQueue";
import { CLAUDE_KIND } from "./kind";
import { sdkModelFor } from "./models";
import {
  attachmentsDirFor,
  buildQueryOptions,
  permissionModeFor,
  sdkEffortFor,
  type SessionLimits,
} from "./queryOptions";
import type { ClaudeSessionRef } from "./sessionRef";
import { makeProcessGroup } from "./spawn";
import { makeToolGate } from "./toolGate";
import type { PendingRuntimeEvent } from "./translate/pending";
import { makeTranslator } from "./translate/translator";
import { userMessage } from "./userMessage";

export interface ClaudeSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binary: ResolvedBinary;
  /** The child's whole environment (`env.ts`). */
  readonly env: Record<string, string>;
  /** What the user types to sign the CLI in, for a request that fails on it. */
  readonly loginCommand: string;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  /** The session to resume; absent for a fresh one. */
  readonly sessionRef?: ClaudeSessionRef;
  /** Said once after `session.started` — why a resume became a fresh start. */
  readonly warning?: string;
  readonly limits?: SessionLimits;
}

/** How long the CLI may take to answer the SDK's initialize request. */
const HANDSHAKE_TIMEOUT = "60 seconds";

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly interrupted: boolean;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeClaudeSession = (
  options: ClaudeSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const { services, threadId } = options;
    const queue = yield* makeBoundedEventQueue();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const closedRef = yield* Ref.make(false);
    const turnRef = yield* Ref.make<ActiveTurn | null>(null);
    // Read synchronously by the SDK's callbacks, so a plain variable.
    let settings = options.settings;

    const emit = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* queue.offer({
          eventId: makeEventId(),
          connectorInstanceId: options.instanceId,
          threadId,
          createdAt: new Date(millis).toISOString(),
          ...pending,
        } as RuntimeEvent);
      });

    const gate = yield* makeApprovalGate({ permissions: services.permissions, emit });
    const toolGate = makeToolGate({
      threadId,
      permissions: services.permissions,
      gate,
      settings: () => settings,
      run,
    });
    const mcp = yield* services.mcpEndpoint(threadId);
    const attachmentsDir = attachmentsDirFor(services.attachmentsDir, threadId);
    yield* Effect.sync(() => {
      try {
        NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      } catch {
        // The CLI only warns about a readable directory that is missing.
      }
    });

    const sessionId = options.sessionRef?.sessionId ?? NodeCrypto.randomUUID();
    const translator = makeTranslator({
      loginCommand: options.loginCommand,
      previousTotalCost:
        options.sessionRef === undefined ? 0 : (options.sessionRef.totalCostUsd ?? null),
    });
    const input = makeInputQueue<SDKUserMessage>();
    const group = makeProcessGroup({
      onStderr: (chunk) => {
        void run(services.logger.log("debug", "claude stderr", { chunk }));
      },
    });
    const abortController = new AbortController();
    const session = query({
      prompt: input.iterable,
      options: buildQueryOptions({
        binaryPath: options.binary.command,
        env: options.env,
        cwd: options.workspaceRoot,
        ...(options.sessionRef === undefined ? { sessionId } : { resume: sessionId }),
        settings,
        mcp,
        attachmentsDir,
        abortController,
        spawn: group.spawn,
        gate: toolGate,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    });

    /** Everything the query started, stopped; used when the start itself fails. */
    const teardown = Effect.gen(function* () {
      input.end();
      yield* Effect.sync(() => session.close());
      abortController.abort();
      yield* group.stop;
    });

    yield* Effect.tryPromise({
      try: () => session.initializationResult(),
      catch: (cause) =>
        new SpawnFailed({
          kind: CLAUDE_KIND,
          instanceId: options.instanceId,
          message: messageOf(cause),
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new SpawnFailed({
              kind: CLAUDE_KIND,
              instanceId: options.instanceId,
              message: "Claude Code did not answer the SDK's initialize request",
            }),
          ),
      }),
      Effect.tapError(() => teardown),
    );

    const currentRef = (): ClaudeSessionRef => {
      const lastAssistantUuid = translator.lastAssistantUuid();
      const totalCostUsd = translator.totalCost();
      return {
        sessionId,
        cwd: options.workspaceRoot,
        ...(lastAssistantUuid === undefined ? {} : { lastAssistantUuid }),
        ...(totalCostUsd === null ? {} : { totalCostUsd }),
      };
    };

    /** `session.started` again with the ref as it stands — the fold replaces the stored one. */
    const announce = Effect.suspend(() =>
      emit({
        type: "session.started",
        payload: {
          sessionRef: currentRef(),
          model: settings.model,
          capabilities: CLAUDE_CAPABILITIES,
        },
      }),
    );

    const handle = (message: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return;
        const turn = yield* Ref.get(turnRef);
        let completed = false;
        for (const event of translator.translate(message, turn)) {
          yield* emit(event);
          if (event.type === "turn.completed") completed = true;
        }
        if (completed) {
          yield* Ref.set(turnRef, null);
          yield* announce;
        }
      });

    /**
     * The one way a session ends. `stopped` when the caller closed it,
     * `crashed` when the CLI went away by itself. It resolves only once the
     * process group is proven gone.
     */
    const endSession = (
      reason: "stopped" | "crashed",
      consumerFiber: Fiber.Fiber<void> | null,
      exitCode?: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(closedRef, true)) return;
        yield* gate.releaseAll("deny");
        input.end();
        yield* Effect.sync(() => session.close());
        if (consumerFiber !== null) yield* Fiber.interrupt(consumerFiber);
        abortController.abort();
        yield* group.stop;
        if (!(yield* group.isGone)) {
          yield* group.stop;
          if (!(yield* group.isGone)) {
            yield* services.logger.log("error", "claude process group survived close", {
              pids: group.children().map((child) => child.pid),
            });
            return yield* Effect.die(new Error("the Claude Code process group survived close"));
          }
        }
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* queue.end;
      });

    /** The CLI stopped while the session was open: say why, then end as a crash. */
    const crashed = (detail: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return;
        const child = group.latest();
        const exit = child === undefined ? undefined : yield* Effect.promise(() => child.exited);
        const tail = child?.stderrTail().trim().split("\n").at(-1) ?? "";
        yield* emit({
          type: "runtime.error",
          payload: { message: tail === "" ? detail : `${detail}: ${tail}`, fatal: true },
        });
        yield* endSession(
          "crashed",
          null,
          exit?.code === null || exit?.code === undefined ? undefined : exit.code,
        );
      });

    yield* announce;
    if (options.warning !== undefined) {
      yield* emit({ type: "session.warning", payload: { message: options.warning } });
    }

    const consumer = yield* Stream.fromAsyncIterable(session, (cause) => cause).pipe(
      Stream.runForEach(handle),
      Effect.matchEffect({
        onFailure: (cause) => crashed(`Claude Code stopped: ${messageOf(cause)}`),
        onSuccess: () => crashed("Claude Code exited"),
      }),
      Effect.forkScoped,
    );

    const close = endSession("stopped", consumer);
    yield* Effect.addFinalizer(() => close);

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return yield* new SessionClosed({ threadId });
        const active = yield* Ref.get(turnRef);
        if (active !== null) {
          return yield* new TurnInProgress({ threadId, activeTurnId: active.turnId });
        }
        const turnId = makeTurnId();
        yield* Ref.set(turnRef, { turnId, interrupted: false });
        yield* emit({ type: "turn.started", payload: { turnId } });
        if (!input.push(userMessage(turn))) return yield* new SessionClosed({ threadId });
      });

    const interrupt = (): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        const active = yield* Ref.get(turnRef);
        if (active === null) return;
        yield* Ref.set(turnRef, { ...active, interrupted: true });
        // A card nobody will answer any more must not hold the stop up.
        yield* gate.releaseAll("deny");
        yield* Effect.tryPromise(() => session.interrupt()).pipe(
          Effect.catch((error) =>
            services.logger.log("warn", "claude interrupt failed", { error: error.message }),
          ),
        );
      });

    const control = (what: string, call: () => Promise<unknown>): Effect.Effect<void> =>
      Effect.tryPromise(call).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          services.logger.log("warn", `claude ${what} failed`, { error: error.message }),
        ),
      );

    const updateSettings = (patch: ThreadSettingsPatch): Effect.Effect<void> =>
      Effect.gen(function* () {
        const before = settings;
        settings = { ...settings, ...patch };
        if (settings.model !== before.model) {
          yield* control("setModel", () => session.setModel(sdkModelFor(settings.model)));
        }
        const mode = permissionModeFor(settings);
        if (mode !== permissionModeFor(before)) {
          yield* control("setPermissionMode", () => session.setPermissionMode(mode));
        }
        if (settings.effort !== before.effort) {
          yield* control("applyFlagSettings", () =>
            session.applyFlagSettings({ effortLevel: sdkEffortFor(settings.effort) ?? null }),
          );
        }
      });

    return {
      events: queue.events,
      send,
      interrupt,
      respondToRequest: (requestId, decision) => gate.respond(requestId, decision),
      // Questions and plans are answered through the tool gate once the
      // session intercepts AskUserQuestion and ExitPlanMode; until then there
      // is nothing parked to answer.
      respondToUserInput: () => Effect.void,
      respondToPlan: () => Effect.void,
      updateSettings,
      sessionRef: () => Effect.sync(currentRef),
      close: () => close,
    };
  });
