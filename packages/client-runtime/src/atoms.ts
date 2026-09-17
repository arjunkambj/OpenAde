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

import type { ConnectorInstanceId, ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type {
  ThreadDetailSnapshot,
  ThreadSummary,
  Command,
  ProjectSummary,
  ThreadListStreamItem,
  ThreadStreamItem,
} from "@OpenAde/contracts/orchestration";
import type {
  BrowserHumanInput,
  BrowserState,
  ConnectorSummary,
  FileSearchResult,
  ModelOption,
  SkillSummary,
} from "@OpenAde/contracts/rpc";
import type { Keybinding, Settings } from "@OpenAde/contracts/settings";
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
 *
 * `retry` covers failures (socket down, RPC error); `repeat` covers the clean
 * end the server sends after `resnapshot-required` — `retry` alone would leave
 * the atom silent until remount.
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
  ).pipe(Stream.retry(resubscribeSchedule), Stream.repeat(resubscribeSchedule));

/**
 * The sidebar list's equivalent loop. Only the `snapshot` frame carries a
 * sequence, so that is the resume point a reconnect asks from; the catch-up
 * frames the server replays are absolute (`upserted` replaces, `removed`
 * filters), which makes replaying the same span twice harmless. A span that
 * has grown past the server's budget comes back as `resnapshot-required`,
 * which drops the resume point and takes a fresh snapshot.
 */
const threadListStream = (
  projectId: ProjectId | null,
  sequence: Ref.Ref<number | null>,
): Stream.Stream<
  ThreadListStreamItem,
  OpenAdeRpcError | RpcClientError.RpcClientError,
  Connection | ConnectionStateRef
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connection = yield* Connection;
      const client = yield* connection.client;
      const connectionState = yield* ConnectionStateRef;
      const hello = yield* client["server.hello"]({});
      const known = yield* SubscriptionRef.get(connectionState);
      const last = yield* Ref.get(sequence);
      const afterSequence =
        last === null || known.serverInstanceId !== hello.serverInstanceId ? undefined : last;
      if (afterSequence === undefined) {
        yield* Ref.set(sequence, null);
      }
      yield* markConnected(hello.serverInstanceId);
      return client["threads.listSubscribe"]({
        ...(projectId === null ? {} : { projectId }),
        ...(afterSequence === undefined ? {} : { afterSequence }),
      });
    }),
  ).pipe(Stream.retry(resubscribeSchedule), Stream.repeat(resubscribeSchedule));

/**
 * A read model that has to be refetched after a reconnect. The socket carries
 * no invalidation, so "the connection came back" is the only signal the client
 * has that the server may have moved on while it was away.
 *
 * `SubscriptionRef.changes` replays the current state, so an atom mounted on a
 * live connection fetches straight away and one mounted before the first
 * connect fetches as soon as it lands — in both cases exactly once per
 * connected epoch.
 */
const perConnection = <A, E>(
  request: Effect.Effect<A, E, Connection>,
): Stream.Stream<A, E, Connection | ConnectionStateRef> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connectionState = yield* ConnectionStateRef;
      return SubscriptionRef.changes(connectionState).pipe(
        Stream.map((state) => state.status === "connected"),
        Stream.changes,
        Stream.filter((connected) => connected),
        Stream.mapEffect(() => request),
      );
    }),
  ).pipe(Stream.retry(resubscribeSchedule));

/** The same treatment for a server-pushed stream: retry a drop, repeat a close. */
const perConnectionStream = <A, E>(
  subscribe: Effect.Effect<Stream.Stream<A, E>, E, Connection>,
): Stream.Stream<A, E, Connection | ConnectionStateRef> =>
  Stream.unwrap(subscribe).pipe(
    Stream.retry(resubscribeSchedule),
    Stream.repeat(resubscribeSchedule),
  );

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
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["projects.list"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<ProjectSummary> },
  );

  const connectorsAtom = runtime.atom(
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["connectors.list"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<ConnectorSummary> },
  );

  const settingsAtom = runtime.atom(
    perConnectionStream(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return client["settings.subscribe"]({});
      }),
    ),
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
        const state = yield* Ref.make<ReadonlyArray<ThreadSummary>>([]);
        const sequence = yield* Ref.make<number | null>(null);
        return threadListStream(projectId, sequence).pipe(
          Stream.mapEffect((item: ThreadListStreamItem) =>
            Effect.gen(function* () {
              if (item.kind === "snapshot") {
                yield* Ref.set(sequence, item.snapshotSequence);
              } else if (item.kind === "resnapshot-required") {
                yield* Ref.set(sequence, null);
              }
              return yield* Ref.updateAndGet(state, (threads) =>
                applyThreadListItem(threads, item),
              );
            }),
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

  /**
   * The composer's `@` search, keyed per project per query. Each key is its
   * own atom, so typing re-runs the RPC only when the query text changes; the
   * component supplies a deferred query value for keystroke coalescing.
   */
  const fileSearchAtom = Atom.family((projectId: ProjectId) =>
    Atom.family((query: string) =>
      runtime.atom(
        Effect.gen(function* () {
          const client = yield* (yield* Connection).client;
          return yield* client["files.search"]({ projectId, query, limit: 20 });
        }),
        { initialValue: [] as ReadonlyArray<FileSearchResult> },
      ),
    ),
  );

  /** The model list a connector instance reported, for the header picker. */
  const connectorModelsAtom = Atom.family((instanceId: ConnectorInstanceId | null) =>
    runtime.atom(
      instanceId === null
        ? Effect.succeed([] as ReadonlyArray<ModelOption>)
        : Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["connectors.models"]({ instanceId });
          }),
      { initialValue: [] as ReadonlyArray<ModelOption> },
    ),
  );

  /** Skills the bound connector advertises, for the `/` popover. */
  const skillsAtom = Atom.family((projectId: ProjectId | null) =>
    runtime.atom(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["cmdConfig.skills.list"](projectId === null ? {} : { projectId });
      }),
      { initialValue: [] as ReadonlyArray<SkillSummary> },
    ),
  );

  /** The server-owned keybinding table the editor and the matcher share. */
  const keybindingsAtom = runtime.atom(
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["keybindings.get"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<Keybinding> },
  );

  /** Replaces the whole table; refreshes `keybindingsAtom` on success. */
  const keybindingsUpdateAtom = runtime.fn((keybindings: ReadonlyArray<Keybinding>, get) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const next = yield* client["keybindings.update"]({ keybindings });
      get.registry.refresh(keybindingsAtom);
      return next;
    }),
  );

  // W6: the thread's live browser state for the pane — `null` until the
  // server answers, then the latest BrowserState (mode, url, frame, activeTool).
  const browserStateAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return client["browser.subscribe"]({ threadId });
      }).pipe(Stream.unwrap, Stream.retry(resubscribeSchedule)),
      { initialValue: null as BrowserState | null },
    ),
  );

  const sendBrowserInput = runtime.fn(
    (args: { readonly threadId: ThreadId; readonly input: BrowserHumanInput }) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["browser.humanInput"]({
          threadId: args.threadId,
          input: args.input,
        });
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
    fileSearchAtom,
    connectorModelsAtom,
    skillsAtom,
    keybindingsAtom,
    keybindingsUpdateAtom,
    browserStateAtom,
    sendBrowserInput,
  };
};
