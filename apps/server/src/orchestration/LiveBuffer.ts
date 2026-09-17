/**
 * The per-subscription live buffer: 50ms coalescing plus a hard budget.
 *
 * Every item the stream has delivered but the consumer has not yet pulled is
 * "retained" and counts against `maxItems`/`maxBytes`. A subscriber that falls
 * too far behind gets a terminal `resnapshot-required` item instead of an
 * ever-growing backlog — the stream ends cleanly and the client re-subscribes
 * for a fresh snapshot.
 *
 * Coalescing merges replaceable items (the latest `item.upserted` for an
 * `itemId`, the latest usage/context frame) while a window is open; a
 * non-mergeable item closes the window immediately so ordering boundaries —
 * `synchronized`, turn boundaries — are never merged away.
 */

import { STREAM_BUDGET_BYTES, STREAM_BUDGET_ITEMS } from "@OpenAde/contracts/rpc";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface LiveBufferOptions<A> {
  /** How long mergeable items wait before flushing. `0` flushes synchronously. */
  readonly window?: Duration.Input;
  readonly maxItems?: number;
  readonly maxBytes?: number;
  /** Approximate serialized size of one item, in bytes. */
  readonly sizeOf: (item: A) => number;
  /**
   * The key an item coalesces under — e.g. `item.upserted` merges per
   * `itemId`. `null` marks a boundary item: it flushes pending work first and
   * is never itself merged.
   */
  readonly mergeKeyOf: (item: A) => string | null;
  /** The terminal item emitted once when the budget overflows. */
  readonly overflowItem: (reason: string) => A;
}

export interface LiveBuffer<A> {
  readonly offer: (item: A) => Effect.Effect<void>;
  readonly offerAll: (items: Iterable<A>) => Effect.Effect<void>;
  /** Emitted items; pulling one releases its budget charge. */
  readonly stream: Stream.Stream<A>;
  /** Ends the stream, delivering `overflowItem` first when a reason is given. */
  readonly close: (reason?: string) => Effect.Effect<void>;
  /** Resolves when the buffer has fully closed — tests await this. */
  readonly closed: Effect.Effect<void>;
  readonly usage: Effect.Effect<{ readonly items: number; readonly bytes: number }>;
}

const jsonSize = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

export const makeLiveBuffer = <A>(
  options: LiveBufferOptions<A>,
): Effect.Effect<LiveBuffer<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxItems = options.maxItems ?? STREAM_BUDGET_ITEMS;
    const maxBytes = options.maxBytes ?? STREAM_BUDGET_BYTES;
    const sizeOf = options.sizeOf;
    const windowMillis = Duration.toMillis(options.window ?? Duration.millis(50));

    const output = yield* Queue.unbounded<A, Cause.Done>();
    const retained = yield* Ref.make({ items: 0, bytes: 0 });
    const pendingRef = yield* Ref.make<ReadonlyArray<A>>([]);
    const pendingKeysRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const timerRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
    const endedRef = yield* Ref.make(false);
    const closedDeferred = yield* Deferred.make<void>();
    // offer, the window flush and close all hold this so a boundary item can
    // never overtake pending merges.
    const mutex = yield* Semaphore.make(1);
    const bufferScope = yield* Effect.scope;

    const charge = (bytes: number): Effect.Effect<void> =>
      Ref.update(retained, (r) => ({ items: r.items + 1, bytes: r.bytes + bytes }));
    const discharge = (item: A): Effect.Effect<void> =>
      Ref.update(retained, (r) => ({ items: r.items - 1, bytes: r.bytes - sizeOf(item) }));

    /** Moves the coalescing window's items to the output. Runs inside `offer`'s critical section. */
    const flushPending: Effect.Effect<void> = Effect.gen(function* () {
      const pending = yield* Ref.getAndSet(pendingRef, []);
      yield* Ref.set(pendingKeysRef, new Map());
      if (pending.length > 0) {
        yield* Queue.offerAll(output, pending);
      }
    });

    const cancelTimer = Ref.getAndSet(timerRef, null).pipe(
      Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
      Effect.asVoid,
    );

    /** The close body — callers inside the mutex use this; the public one locks. */
    const closeInner = (reason?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(endedRef)) {
          return;
        }
        yield* Ref.set(endedRef, true);
        yield* cancelTimer;
        const pending = yield* Ref.getAndSet(pendingRef, []);
        yield* Ref.set(pendingKeysRef, new Map());
        // Pending merges are released, not delivered: the resnapshot covers them.
        for (const item of pending) {
          yield* discharge(item);
        }
        if (reason !== undefined) {
          yield* Queue.offer(output, options.overflowItem(reason));
        }
        yield* Queue.end(output);
        yield* Deferred.succeed(closedDeferred, undefined);
      });

    const close = (reason?: string): Effect.Effect<void> =>
      Effect.uninterruptible(mutex.withPermits(1)(closeInner(reason)));

    const offer = (item: A): Effect.Effect<void> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (yield* Ref.get(endedRef)) {
            return;
          }
          const bytes = sizeOf(item);
          const current = yield* Ref.get(retained);
          if (current.items + 1 > maxItems || current.bytes + bytes > maxBytes) {
            yield* closeInner("live event buffer is full; resubscribe for a fresh snapshot");
            return;
          }
          const key = options.mergeKeyOf(item);
          if (key === null) {
            // Boundary: pending merges flush first so they keep their place.
            yield* flushPending;
            yield* charge(bytes);
            yield* Queue.offer(output, item);
            return;
          }
          const keys = yield* Ref.get(pendingKeysRef);
          const existingIndex = keys.get(key);
          if (existingIndex !== undefined) {
            // Replace in place: the older merged item's charge is exchanged.
            const pending = yield* Ref.get(pendingRef);
            const previous = pending[existingIndex]!;
            yield* Ref.update(pendingRef, (all) =>
              all.map((candidate, i) => (i === existingIndex ? item : candidate)),
            );
            yield* Ref.update(retained, (r) => ({
              items: r.items,
              bytes: r.bytes - sizeOf(previous) + bytes,
            }));
            return;
          }
          yield* charge(bytes);
          const index = yield* Ref.modify(
            pendingRef,
            (all) => [all.length, [...all, item]] as const,
          );
          yield* Ref.update(pendingKeysRef, (all) => new Map(all).set(key, index));
          if (windowMillis === 0) {
            yield* flushPending;
            return;
          }
          if ((yield* Ref.get(timerRef)) === null) {
            const fiber = yield* Effect.forkIn(
              Effect.sleep(Duration.millis(windowMillis)).pipe(
                Effect.andThen(
                  mutex.withPermits(1)(
                    Effect.gen(function* () {
                      // Clear the slot before flushing: a fired timer is no
                      // longer armed, so the next offer must see `null` and
                      // fork a fresh window — otherwise every later mergeable
                      // item would sit in `pendingRef` forever.
                      yield* Ref.set(timerRef, null);
                      yield* flushPending;
                    }),
                  ),
                ),
              ),
              bufferScope,
            );
            yield* Ref.set(timerRef, fiber);
          }
        }),
      );

    const stream = Stream.fromQueue(output).pipe(
      Stream.mapEffect((item) => Effect.as(discharge(item), item)),
      Stream.ensuring(
        Effect.gen(function* () {
          // Release anything still buffered when the consumer goes away.
          const remaining = yield* Queue.clear(output);
          for (const item of remaining) {
            yield* discharge(item);
          }
          const pending = yield* Ref.getAndSet(pendingRef, []);
          for (const item of pending) {
            yield* discharge(item);
          }
          yield* close();
        }),
      ),
    );

    yield* Effect.addFinalizer(() => close());

    return {
      offer,
      offerAll: (items) => Effect.forEach(items, offer, { discard: true }),
      stream,
      close,
      closed: Deferred.await(closedDeferred),
      usage: Ref.get(retained).pipe(Effect.map((r) => ({ items: r.items, bytes: r.bytes }))),
    };
  });

/** The merge key a `ThreadStreamItem` coalesces under, if it is mergeable. */
export const threadItemMergeKey = (item: {
  readonly kind: string;
  readonly event?: { readonly type: string; readonly payload: unknown };
}): string | null => {
  if (item.kind !== "event" || item.event === undefined) {
    return null;
  }
  const payload = item.event.payload as Record<string, unknown>;
  switch (item.event.type) {
    case "thread.item.upserted":
      return `item:${(payload.item as { itemId: string }).itemId}`;
    case "thread.usage.updated":
      return `usage:${payload.turnId as string}`;
    case "thread.context.updated":
      return "context";
    default:
      return null;
  }
};

/** The same for thread-list items: the latest `upserted` per thread wins. */
export const threadListMergeKey = (item: {
  readonly kind: string;
  readonly thread?: { readonly threadId: string };
  readonly threadId?: string;
}): string | null => {
  if (item.kind === "upserted" && item.thread !== undefined) {
    return `thread:${item.thread.threadId}`;
  }
  if (item.kind === "removed" && item.threadId !== undefined) {
    return `removed:${item.threadId}`;
  }
  return null;
};

export const sizeOfJson = jsonSize;
