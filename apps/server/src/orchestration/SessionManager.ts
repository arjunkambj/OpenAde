/**
 * Which connector instance a thread talks to, and the live sessions on top.
 *
 * `ConnectorSelection` is the seam W9's settings UI will own: for now an
 * instance is "the first one registered", which is what the fake-connector
 * tests provide. Routing on a thread that already has a session always goes by
 * the persisted `connectorInstanceId` — two instances of the same kind can
 * differ in binary, credentials and model, so kind is never a lookup key.
 *
 * `SessionManager` keeps one driver per thread: the turn-scoped handle plus
 * the ingestion fiber draining its events into the log. A driver is removed
 * when its event stream ends (terminal events are guaranteed delivered) or
 * when the thread is deleted.
 */

import type { ConnectorInstanceId, ThreadId } from "@OpenAde/contracts/ids";
import type { ConnectorError, ConnectorInstance } from "@OpenAde/connector-sdk/definition";
import { ConnectorNotFound } from "@OpenAde/connector-sdk/definition";
import type { ConnectorRegistry } from "@OpenAde/connector-sdk/registry";
import type { SessionHandle } from "@OpenAde/connector-sdk/sessionHandle";
import {
  makeTurnScopedHandle,
  type TurnScopedSessionHandle,
} from "@OpenAde/connector-sdk/turnScopedHandle";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { EngineEnv, OrchestrationEngine } from "./Engine";
import { ingestSession, type SessionLifecycle } from "./RuntimeIngestion";
import type { ThreadDoc } from "./state";

// ── Connector selection ───────────────────────────────────────

/** No connector instance is registered to run a thread on. */
export class NoConnector extends Data.TaggedError("NoConnector")<{
  readonly threadId: ThreadId;
}> {}

export class ConnectorSelection extends Context.Service<
  ConnectorSelection,
  {
    readonly instanceFor: (
      doc: ThreadDoc,
    ) => Effect.Effect<ConnectorInstance, ConnectorError | NoConnector>;
    readonly instanceById: (
      instanceId: ConnectorInstanceId,
    ) => Effect.Effect<ConnectorInstance, ConnectorNotFound>;
  }
>()("server/orchestration/ConnectorSelection") {
  /** Over the live registry: first registered instance for new threads. */
  static readonly fromRegistry = (registry: ConnectorRegistry): Layer.Layer<ConnectorSelection> =>
    Layer.succeed(ConnectorSelection, {
      instanceFor: (doc) =>
        registry.instances.pipe(
          Effect.flatMap((instances) => {
            const first = instances[0];
            return first === undefined
              ? Effect.fail(new NoConnector({ threadId: doc.threadId }))
              : Effect.succeed(first);
          }),
        ),
      instanceById: (instanceId) => registry.instance(instanceId),
    });

  /** A fixed instance — what the W1 tests and a single-connector build want. */
  static readonly fromInstance = (instance: ConnectorInstance): Layer.Layer<ConnectorSelection> =>
    Layer.succeed(ConnectorSelection, {
      instanceFor: () => Effect.succeed(instance),
      instanceById: (instanceId) =>
        instanceId === instance.instanceId
          ? Effect.succeed(instance)
          : Effect.fail(new ConnectorNotFound({ instanceId, kind: instance.kind })),
    });
}

// ── Session drivers ───────────────────────────────────────────

interface SessionDriver {
  readonly handle: TurnScopedSessionHandle;
  readonly scope: Scope.Closeable;
  /**
   * False once the ingestion fiber ended — the map entry can outlive the
   * session by a scheduling step, and a dead handle must not be handed out.
   */
  readonly alive: Ref.Ref<boolean>;
}

export class SessionManager extends Context.Service<
  SessionManager,
  {
    /** The thread's live handle, if a session is running. */
    readonly handleFor: (threadId: ThreadId) => Effect.Effect<TurnScopedSessionHandle | null>;
    /**
     * Starts or resumes the thread's session: `resumeSession` when the document
     * carries a bound `sessionRef`, `startSession` otherwise.
     */
    readonly ensure: (
      doc: ThreadDoc,
      projectWorkspaceRoot: string,
    ) => Effect.Effect<TurnScopedSessionHandle, ConnectorError | ConnectorNotFound | NoConnector>;
    /** Closes and deregisters the thread's session, if one is running. */
    readonly close: (threadId: ThreadId) => Effect.Effect<void>;
    /** Session start/end reports — the supervisor's input. */
    readonly lifecycle: Stream.Stream<SessionLifecycle>;
  }
>()("server/orchestration/SessionManager") {
  static readonly layer = Layer.effect(
    SessionManager,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const selection = yield* ConnectorSelection;
      const drivers = yield* Ref.make<ReadonlyMap<ThreadId, SessionDriver>>(new Map());
      const lifecycle = yield* PubSub.unbounded<SessionLifecycle>();
      // One attach at a time: a raced ensure() must not spawn two sessions.
      const attachMutex = yield* Semaphore.make(1);

      const report = (entry: SessionLifecycle) => PubSub.publish(lifecycle, entry);

      const attach = (
        doc: ThreadDoc,
        workspaceRoot: string,
      ): Effect.Effect<TurnScopedSessionHandle, ConnectorError | ConnectorNotFound | NoConnector> =>
        attachMutex.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* Ref.get(drivers);
            const running = existing.get(doc.threadId);
            if (running !== undefined && (yield* Ref.get(running.alive))) {
              return running.handle;
            }
            const instance =
              doc.session === null
                ? yield* selection.instanceFor(doc)
                : yield* selection.instanceById(doc.session.connectorInstanceId);

            const input = {
              threadId: doc.threadId,
              projectId: doc.projectId,
              workspaceRoot,
              settings: doc.settings,
            };
            const driverScope = yield* Scope.make();
            const raw: SessionHandle = yield* (
              doc.session === null
                ? instance.startSession(input)
                : instance.resumeSession({ ...input, sessionRef: doc.session.sessionRef })
            ).pipe(Scope.provide(driverScope));
            const handle = yield* makeTurnScopedHandle(raw, {
              connectorInstanceId: instance.instanceId,
              threadId: doc.threadId,
            });

            const alive = yield* Ref.make(true);
            const engineEnv = yield* EngineEnv;
            // `ended` is buffered, not reported: the lifecycle channel only
            // sees it after the driver is deregistered, so a supervisor that
            // reacts to `crashed` never observes a still-registered corpse.
            const ended = yield* Ref.make<SessionLifecycle | null>(null);
            const ingest = ingestSession(
              handle,
              {
                threadId: doc.threadId,
                connectorInstanceId: instance.instanceId,
                connectorKind: instance.kind,
              },
              {
                nextEventId: engineEnv.nextEventId,
                append: (threadId, events) =>
                  engine
                    .appendThreadEvents(threadId, events)
                    .pipe(
                      Effect.catch((error) => Effect.logWarning("ingest append failed", error)),
                    ),
                report: (entry) => (entry.kind === "ended" ? Ref.set(ended, entry) : report(entry)),
              },
            ).pipe(
              // The event stream ends only after the session's terminal events,
              // so an ending ingestion fiber means the driver is dead.
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Ref.set(alive, false);
                  yield* Ref.update(drivers, (all) => {
                    const next = new Map(all);
                    next.delete(doc.threadId);
                    return next;
                  });
                  yield* Scope.close(driverScope, Exit.succeed(undefined));
                  const entry = yield* Ref.get(ended);
                  // A stream that ends without `session.ended` is a crash —
                  // the process is gone either way.
                  yield* report(
                    entry ?? {
                      kind: "ended",
                      threadId: doc.threadId,
                      connectorInstanceId: instance.instanceId,
                      reason: "crashed",
                    },
                  );
                }),
              ),
            );
            yield* Effect.forkIn(ingest, driverScope);

            yield* Ref.update(drivers, (all) =>
              new Map(all).set(doc.threadId, { handle, scope: driverScope, alive }),
            );
            yield* report({
              kind: "started",
              threadId: doc.threadId,
              connectorInstanceId: instance.instanceId,
            });
            return handle;
          }),
        );

      return SessionManager.of({
        handleFor: (threadId) =>
          Effect.gen(function* () {
            const driver = (yield* Ref.get(drivers)).get(threadId);
            if (driver === undefined || !(yield* Ref.get(driver.alive))) {
              return null;
            }
            return driver.handle;
          }),
        ensure: (doc, projectWorkspaceRoot) => attach(doc, projectWorkspaceRoot),
        close: (threadId) =>
          Effect.gen(function* () {
            const all = yield* Ref.get(drivers);
            const driver = all.get(threadId);
            if (driver === undefined) {
              return;
            }
            yield* Ref.set(driver.alive, false);
            yield* Ref.update(drivers, (map) => {
              const next = new Map(map);
              next.delete(threadId);
              return next;
            });
            yield* Scope.close(driver.scope, Exit.succeed(undefined));
          }),
        lifecycle: Stream.fromPubSub(lifecycle),
      });
    }),
  );
}
