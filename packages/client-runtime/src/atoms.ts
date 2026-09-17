/**
 * The atom layer of the client runtime. `makeRuntime(connectionLayer)` builds
 * an `AtomRuntime` over the connection, then each factory answers one piece of
 * UI state:
 *
 * - `threadDetailAtom(threadId)` — live thread view; reconnects resume with
 *   `afterSequence`, `resnapshot-required` restarts from scratch, and a changed
 *   `serverInstanceId` discards the cached snapshot entirely.
 * - `threadListAtom(projectId)` — the sidebar list.
 * - `projectsAtom`, `connectorsAtom`, `settingsAtom` — read models.
 * - `connectionStateAtom` — the reconnecting banner's source.
 * - `dispatchAtom` — sends a `Command` and resolves with its receipt.
 */

import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type {
  ThreadDetailSnapshot,
  ThreadSummary,
  Command,
  ProjectSummary,
  ThreadListStreamItem,
  ThreadStreamItem,
} from "@OpenAde/contracts/orchestration";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import type { Settings } from "@OpenAde/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { OpenAdeRpcError } from "@OpenAde/contracts/rpc";

import { Connection, ConnectionStateRef, markConnected } from "./connection";
import { applyThreadListItem, applyThreadStreamItem } from "./clientState";

export interface ConnectionLayer extends Layer.Layer<
  Connection | ConnectionStateRef,
  never,
  Scope.Scope
> {}

/**
 * Retries a subscription until it holds: while the socket is down each attempt
 * fails fast, the protocol's own reconnect runs underneath, and the next try
 * lands on the fresh socket. Jitter keeps every subscriber from resubscribing
 * in the same tick.
 */
const resubscribeSchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((meta) => Effect.succeed(Duration.min(meta.duration, Duration.seconds(2)))),
);

/**
 * `hello → subscribe` as one resumable loop. The hello doubles as the
 * instance-id check; a changed id resets `afterSequence` and clears the atom's
 * snapshot so stale projections can't survive a server restart.
 */
const threadStream = (
  threadId: ThreadId,
  state: Ref.Ref<ThreadDetailSnapshot | null>,
): Stream.Stream<
  ThreadStreamItem,
  OpenAdeRpcError | RpcClientError.RpcClientError,
  Connection | ConnectionStateRef
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connection = yield* Connection;
      const client = yield* connection.client;
      const connectionState = yield* ConnectionStateRef;
      const hello = yield* client["server.hello"]({});
      const doc = yield* Ref.get(state);
      const known = yield* SubscriptionRef.get(connectionState);
      const afterSequence =
        doc === null || known.serverInstanceId !== hello.serverInstanceId
          ? undefined
          : doc.snapshotSequence;
      if (afterSequence === undefined) {
        yield* Ref.set(state, null);
      }
      yield* markConnected(hello.serverInstanceId);
      return client["threads.subscribe"]({ threadId, afterSequence });
    }),
  ).pipe(Stream.retry(resubscribeSchedule));

export const makeRuntime = (connectionLayer: ConnectionLayer) => {
  // Build the connection inside the runtime's own scope so the supervisor's
  // fibers live exactly as long as the atoms that depend on them.
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ctx = yield* Layer.build(connectionLayer).pipe(Scope.provide(scope));
      return Layer.succeedContext(ctx);
    }),
  );
  const runtime = Atom.runtime(layer);

  const connectionStateAtom = runtime.atom(
    Effect.gen(function* () {
      const ref = yield* ConnectionStateRef;
      return SubscriptionRef.changes(ref);
    }).pipe(Stream.unwrap),
    { initialValue: { status: "connecting" as const, serverInstanceId: null } },
  );

  const projectsAtom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["projects.list"]({});
    }),
    { initialValue: [] as ReadonlyArray<ProjectSummary> },
  );

  const connectorsAtom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["connectors.list"]({});
    }),
    { initialValue: [] as ReadonlyArray<ConnectorSummary> },
  );

  const settingsAtom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return client["settings.subscribe"]({});
    }).pipe(Stream.unwrap),
    { initialValue: null as Settings | null },
  );

  const threadDetailAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      Effect.gen(function* () {
        const state = yield* Ref.make<ThreadDetailSnapshot | null>(null);
        return threadStream(threadId, state).pipe(
          Stream.mapEffect((item) =>
            Effect.gen(function* () {
              if (item.kind === "resnapshot-required") {
                yield* Ref.set(state, null);
              }
              return yield* Ref.updateAndGet(state, (doc) => applyThreadStreamItem(doc, item));
            }),
          ),
          Stream.filter((doc): doc is ThreadDetailSnapshot => doc !== null),
        );
      }).pipe(Stream.unwrap),
    ),
  );

  const threadListAtom = Atom.family((projectId: ProjectId | null) =>
    runtime.atom(
      Effect.gen(function* () {
        const connection = yield* Connection;
        const client = yield* connection.client;
        const state = yield* Ref.make<ReadonlyArray<ThreadSummary>>([]);
        return Stream.suspend(() =>
          client["threads.listSubscribe"](projectId === null ? {} : { projectId }),
        ).pipe(
          Stream.retry(resubscribeSchedule),
          Stream.mapEffect((item: ThreadListStreamItem) =>
            Ref.updateAndGet(state, (threads) => applyThreadListItem(threads, item)),
          ),
        );
      }).pipe(Stream.unwrap),
      { initialValue: [] as ReadonlyArray<ThreadSummary> },
    ),
  );

  const dispatchAtom = runtime.fn((command: Command) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["orchestration.dispatch"]({ command });
    }),
  );

  return {
    runtime,
    connectionStateAtom,
    projectsAtom,
    connectorsAtom,
    settingsAtom,
    threadDetailAtom,
    threadListAtom,
    dispatchAtom,
  };
};
