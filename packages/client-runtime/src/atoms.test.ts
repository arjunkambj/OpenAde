/**
 * Atom-level tests over a stubbed RPC client — the done-when pieces that live
 * entirely in the client runtime: per-thread isolation, resnapshot handling,
 * and the `serverInstanceId` reset.
 */

import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { makeEventId, makeItemId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot, ThreadStreamItem } from "@OpenAde/contracts/orchestration";
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

/**
 * A client stub: `server.hello` answers the current instance id, and
 * `threads.subscribe` drains the per-thread queue (or hangs forever when the
 * thread is unknown).
 */
const fakeClient = (
  streams: Map<string, Queue.Queue<ThreadStreamItem, unknown>>,
  instanceId: Ref.Ref<string>,
): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      if (key === "server.hello") {
        return () =>
          Ref.get(instanceId).pipe(
            Effect.map((serverInstanceId) => ({
              protocolVersion: 1,
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
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
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
});
