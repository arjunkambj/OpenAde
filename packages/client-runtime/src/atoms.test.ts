/**
 * Atom-level tests over a stubbed RPC client — the done-when pieces that live
 * entirely in the client runtime: per-thread isolation, resnapshot handling,
 * and the `serverInstanceId` reset.
 */

import { PROTOCOL_VERSION } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { makeEventId, makeItemId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type {
  ProjectSummary,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";
import type { Settings } from "@OpenAde/contracts/settings";
import { defaultSettings } from "@OpenAde/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";

const INSTANCE = "01900000-0000-7000-8000-000000000000";

const snapshot = (
  threadId: ThreadId,
  items: ThreadDetailSnapshot["items"] = [],
): ThreadDetailSnapshot => ({
  threadId,
  projectId: makeProjectId(),
  title: "test",
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  snapshotSequence: 1,
  items,
  queue: [],
  checkpoints: [],
  session: null,
  currentTurnId: null,
  pendingApproval: null,
  pendingUserInput: null,
  pendingPlan: null,
  usage: null,
  context: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const upsert = (threadId: ThreadId, sequence: number, text: string): ThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: makeEventId(),
    type: "thread.item.upserted",
    sequence,
    streamKind: "thread",
    streamId: threadId,
    streamVersion: sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "connector",
    payload: {
      item: {
        itemId: makeItemId(),
        kind: "assistant_message",
        status: "completed",
        text,
      },
    },
  },
});

/** How a test feeds `threads.listSubscribe` and reads back what it was asked. */
interface ListChannel {
  readonly queue: () => Queue.Queue<ThreadListStreamItem, unknown>;
  readonly calls: Array<{ readonly afterSequence?: number }>;
}

/** The read models a test wants the stub to answer. */
interface StubData {
  readonly list?: ListChannel;
  readonly projects?: Ref.Ref<ReadonlyArray<ProjectSummary>>;
  readonly settings?: () => Queue.Queue<Settings, unknown>;
  /** What `server.hello` claims to speak; defaults to this build's version. */
  readonly protocolVersion?: number;
}

/**
 * A client stub: `server.hello` answers the current instance id,
 * `threads.subscribe` drains the per-thread queue (or hangs forever when the
 * thread is unknown), `threads.listSubscribe` drains whatever queue the
 * channel currently points at (recording each subscribe payload), and the read
 * models answer from whatever the test last put in front of them.
 */
const fakeClient = (
  streams: Map<string, Queue.Queue<ThreadStreamItem, unknown>>,
  instanceId: Ref.Ref<string>,
  data: StubData = {},
): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      if (key === "server.hello") {
        return () =>
          Ref.get(instanceId).pipe(
            Effect.map((serverInstanceId) => ({
              protocolVersion: data.protocolVersion ?? PROTOCOL_VERSION,
              serverInstanceId,
            })),
          );
      }
      if (key === "threads.subscribe") {
        return ({ threadId }: { threadId: string }) => {
          const queue = streams.get(threadId);
          return queue === undefined ? Stream.never : Stream.fromQueue(queue);
        };
      }
      if (key === "threads.listSubscribe" && data.list !== undefined) {
        const list = data.list;
        return (payload: { afterSequence?: number }) => {
          list.calls.push(payload);
          return Stream.suspend(() => Stream.fromQueue(list.queue()));
        };
      }
      if (key === "projects.list" && data.projects !== undefined) {
        const projects = data.projects;
        return () => Ref.get(projects);
      }
      if (key === "settings.subscribe" && data.settings !== undefined) {
        const settings = data.settings;
        return () => Stream.suspend(() => Stream.fromQueue(settings()));
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const summary = (threadId: ThreadId, title: string): ThreadSummary => ({
  threadId,
  projectId: makeProjectId(),
  title,
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  awaitingInput: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const project = (name: string): ProjectSummary => ({
  projectId: makeProjectId(),
  name,
  workspaceRoot: `/repo/${name}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  threadCount: 0,
});

const runtimeWith = (client: OpenAdeRpcClient, state: ConnectionState) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(state);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, {
        client: Effect.succeed(client),
        state: stateRef,
      }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    return { registry: AtomRegistry.make(), stateRef, ...makeRuntime(layer) };
  });

/** Awaits the first success value matching the predicate — no timers in logic. */
const awaitValue = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    // `subscribe` only fires on change — replay the current value explicitly.
    check(registry.get(atom));
  });

describe("atoms", () => {
  it.live("thread detail atoms update only for their own thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const threadB = makeThreadId();
        const queueA = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const queueB = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadA, queueA],
          [threadB, queueB],
        ]);
        const { registry, threadDetailAtom } = yield* runtimeWith(fakeClient(streams, instance), {
          status: "connecting",
          serverInstanceId: null,
        });

        const atomA = threadDetailAtom(threadA);
        const atomB = threadDetailAtom(threadB);
        registry.mount(atomA);
        registry.mount(atomB);

        // Baseline snapshots for both threads.
        yield* Queue.offer(queueA, {
          kind: "snapshot",
          snapshot: snapshot(threadA),
        });
        yield* Queue.offer(queueB, {
          kind: "snapshot",
          snapshot: snapshot(threadB),
        });
        yield* Effect.promise(() => awaitValue(registry, atomA, (doc) => doc !== null));
        yield* Effect.promise(() => awaitValue(registry, atomB, (doc) => doc !== null));

        // An event scoped to A must not touch B.
        yield* Queue.offer(queueA, upsert(threadA, 2, "hello A"));
        yield* Effect.promise(() => awaitValue(registry, atomA, (doc) => doc.items.length === 1));
        const docB = registry.get(atomB);
        expect(AsyncResult.isSuccess(docB) && docB.value.items.length).toBe(0);
      }),
    ),
  );

  it.live("resnapshot-required clears the doc and the next snapshot replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const { registry, threadDetailAtom } = yield* runtimeWith(
          fakeClient(new Map([[threadId, queue]]), instance),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "old item"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 0));
      }),
    ),
  );

  it.live("a subscription that ends after resnapshot-required resubscribes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadId, queue],
        ]);
        const { registry, threadDetailAtom } = yield* runtimeWith(fakeClient(streams, instance), {
          status: "connecting",
          serverInstanceId: null,
        });

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "old item"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        // The server ends the stream cleanly after resnapshot-required —
        // `Stream.retry` alone never fires on a clean end, so the atom must
        // resubscribe itself. The swapped-in queue stands in for the fresh
        // subscription the repeat opens.
        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Queue.end(queue);

        const queue2 = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        streams.set(threadId, queue2);
        yield* Queue.offer(queue2, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 0));
      }),
    ),
  );

  it.live("the thread list survives a dropped subscription and resumes from its snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const threadB = makeThreadId();
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        const list: ListChannel = { queue: () => queue, calls: [] };
        const { registry, threadListAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { list }),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadListAtom(null);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 7,
          threads: [summary(threadA, "first")],
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 1));

        // The socket drops mid-subscription. Before the fix the atom held a
        // dead client and retried against it forever, so the sidebar froze.
        const dropped = queue;
        queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        yield* Queue.offer(queue, { kind: "upserted", thread: summary(threadB, "second") });
        yield* Queue.fail(dropped, new Error("socket dropped"));

        const threads = yield* Effect.promise(() =>
          awaitValue(registry, atom, (value) => value.length === 2),
        );
        expect(threads.map((t) => t.title)).toEqual(["first", "second"]);
        // The resubscribe asked for catch-up from the snapshot it holds.
        expect(list.calls.at(-1)?.afterSequence).toBe(7);
      }),
    ),
  );

  it.live("resnapshot-required clears the thread list and drops the resume point", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        const list: ListChannel = { queue: () => queue, calls: [] };
        const { registry, threadListAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { list }),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadListAtom(null);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 7,
          threads: [summary(threadA, "first")],
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 1));

        // The server gives up on replay and ends the stream cleanly — only the
        // `repeat` reopens it, and the next subscribe must not resume from 7.
        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 0));
        const ended = queue;
        queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 11,
          threads: [summary(threadA, "rebuilt")],
        });
        yield* Queue.end(ended);

        const threads = yield* Effect.promise(() =>
          awaitValue(registry, atom, (value) => value.some((t) => t.title === "rebuilt")),
        );
        expect(threads.length).toBe(1);
        expect(list.calls.at(-1)?.afterSequence).toBeUndefined();
      }),
    ),
  );

  it.live("a request read model refetches when the connection comes back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const projects = yield* Ref.make<ReadonlyArray<ProjectSummary>>([project("one")]);
        const { registry, stateRef, projectsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { projects }),
          { status: "connecting", serverInstanceId: null },
        );

        registry.mount(projectsAtom);
        yield* SubscriptionRef.set(stateRef, { status: "connected", serverInstanceId: INSTANCE });
        yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (list) => list.length === 1),
        );

        // The server gained a project while the socket was down. Nothing
        // pushes projects, so the reconnect is the only cue to refetch.
        yield* Ref.set(projects, [project("one"), project("two")]);
        yield* SubscriptionRef.set(stateRef, {
          status: "reconnecting",
          serverInstanceId: INSTANCE,
        });
        yield* SubscriptionRef.set(stateRef, { status: "connected", serverInstanceId: INSTANCE });

        const list = yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (value) => value.length === 2),
        );
        expect(list.map((p) => p.name)).toEqual(["one", "two"]);
      }),
    ),
  );

  it.live("settings recover after the subscription drops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<Settings, unknown>();
        const { registry, settingsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { settings: () => queue }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        registry.mount(settingsAtom);
        yield* Queue.offer(queue, { ...defaultSettings(), theme: "light" });
        yield* Effect.promise(() =>
          awaitValue(registry, settingsAtom, (value) => value?.theme === "light"),
        );

        // Before the fix the atom failed here and stayed failed forever, so
        // the settings pane was frozen for the rest of the session.
        const dropped = queue;
        queue = yield* Queue.unbounded<Settings, unknown>();
        yield* Queue.offer(queue, { ...defaultSettings(), theme: "dark" });
        yield* Queue.fail(dropped, new Error("socket dropped"));

        yield* Effect.promise(() =>
          awaitValue(registry, settingsAtom, (value) => value?.theme === "dark"),
        );
      }),
    ),
  );

  it.live("a changed serverInstanceId discards the cached snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadId, queue],
        ]);
        const { registry, stateRef, threadDetailAtom } = yield* runtimeWith(
          fakeClient(streams, instance),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "kept?"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        // Simulate a server restart: the instance id changes, so the next
        // subscribe attempt must not resume with the old sequence. Ending the
        // queue forces the stream loop to re-run; the swapped-in queue stands
        // in for the fresh subscription the retry opens.
        yield* Ref.set(instance, "01900000-0000-7000-8000-000000000001");
        yield* SubscriptionRef.set(stateRef, {
          status: "reconnecting",
          serverInstanceId: null,
        });
        const queue2 = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        streams.set(threadId, queue2);
        // A failed stream triggers the retry loop — an ended one does not.
        yield* Queue.fail(queue, new Error("socket dropped"));

        yield* Queue.offer(queue2, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        const doc = yield* Effect.promise(() =>
          awaitValue(registry, atom, (d) => d.items.length === 0),
        );
        expect(doc.items.length).toBe(0);
      }),
    ),
  );

  it.live("a server on another protocol version parks instead of subscribing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const { registry, stateRef, threadDetailAtom } = yield* runtimeWith(
          fakeClient(new Map([[threadId, queue]]), instance, {
            protocolVersion: PROTOCOL_VERSION + 1,
          }),
          { status: "connecting", serverInstanceId: null },
        );

        registry.mount(threadDetailAtom(threadId));
        // Decoding the other build's frames would fail opaquely, so the atom
        // must never subscribe; the banner reads the status instead.
        const seen = yield* SubscriptionRef.changes(stateRef).pipe(
          Stream.filter((state) => state.status === "incompatible"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        expect(seen[0]?.status).toBe("incompatible");

        // A snapshot on the wire must not reach the atom.
        yield* Queue.offer(queue, { kind: "snapshot", snapshot: snapshot(threadId) });
        const result = registry.get(threadDetailAtom(threadId));
        expect(AsyncResult.isSuccess(result)).toBe(false);
      }),
    ),
  );
});
