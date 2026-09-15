/**
 * Watching a stream from a test without sleeping on it.
 *
 * Connector work is asynchronous by nature: a prompt goes in, events come out
 * later, on another fiber. A test that waits with a timer is a test that is
 * either slow or flaky, so nothing in this repository does. Instead a collector
 * drains the stream into a buffer and hands out `Deferred`s: `awaitItem`
 * resolves the moment a matching item arrives — or immediately, if one already
 * has — and fails once the stream is over, so a wait for something that will
 * never come ends as a failure instead of a hang.
 */

import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** The stream finished without ever producing the item that was awaited. */
export class StreamEnded extends Data.TaggedError("StreamEnded")<{
  readonly seen: number;
}> {}

export interface StreamCollector<A> {
  /** Everything seen so far, in arrival order. */
  readonly collected: Effect.Effect<ReadonlyArray<A>>;
  /** Resolves with the first item matching `predicate`, past or future. */
  readonly awaitItem: (predicate: (item: A) => boolean) => Effect.Effect<A, StreamEnded>;
  /** Resolves when the stream is over. */
  readonly awaitDone: Effect.Effect<void>;
  readonly isDone: Effect.Effect<boolean>;
}

interface Waiter<A> {
  readonly predicate: (item: A) => boolean;
  readonly deferred: Deferred.Deferred<A, StreamEnded>;
}

interface CollectorState<A> {
  readonly items: ReadonlyArray<A>;
  readonly waiters: ReadonlyArray<Waiter<A>>;
  readonly done: boolean;
}

/**
 * Starts draining `stream` on a fiber bound to the current scope. The fiber is
 * interrupted when the scope closes, so a test that ends early does not leave
 * one behind.
 */
export const makeStreamCollector = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<StreamCollector<A>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<CollectorState<A>>({ items: [], waiters: [], done: false });
    const finished = yield* Deferred.make<void>();

    const onItem = (item: A): Effect.Effect<void> =>
      Ref.modify(state, (current): readonly [ReadonlyArray<Waiter<A>>, CollectorState<A>] => [
        current.waiters.filter((waiter) => waiter.predicate(item)),
        {
          ...current,
          items: [...current.items, item],
          waiters: current.waiters.filter((waiter) => !waiter.predicate(item)),
        },
      ]).pipe(
        Effect.flatMap((matched) =>
          Effect.forEach(matched, (waiter) => Deferred.succeed(waiter.deferred, item)),
        ),
        Effect.asVoid,
      );

    const finish: Effect.Effect<void> = Ref.modify(
      state,
      (
        current,
      ): readonly [
        { readonly waiters: ReadonlyArray<Waiter<A>>; readonly seen: number },
        CollectorState<A>,
      ] => [
        { waiters: current.waiters, seen: current.items.length },
        { ...current, waiters: [], done: true },
      ],
    ).pipe(
      Effect.flatMap(({ seen, waiters }) =>
        Effect.forEach(waiters, (waiter) =>
          Deferred.fail(waiter.deferred, new StreamEnded({ seen })),
        ),
      ),
      Effect.flatMap(() => Deferred.succeed(finished, undefined)),
      Effect.asVoid,
    );

    yield* Effect.forkScoped(Stream.runForEach(stream, onItem).pipe(Effect.ensuring(finish)));

    const awaitItem = (predicate: (item: A) => boolean): Effect.Effect<A, StreamEnded> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<A, StreamEnded>();
        const outcome = yield* Ref.modify(
          state,
          (
            current,
          ): readonly [
            (
              | { readonly kind: "now"; readonly item: A }
              | { readonly kind: "ended"; readonly seen: number }
              | { readonly kind: "later" }
            ),
            CollectorState<A>,
          ] => {
            const existing = current.items.find(predicate);
            if (existing !== undefined) {
              return [{ kind: "now", item: existing }, current];
            }
            if (current.done) {
              return [{ kind: "ended", seen: current.items.length }, current];
            }
            return [
              { kind: "later" },
              { ...current, waiters: [...current.waiters, { predicate, deferred }] },
            ];
          },
        );

        if (outcome.kind === "now") {
          return outcome.item;
        }
        if (outcome.kind === "ended") {
          return yield* Effect.fail(new StreamEnded({ seen: outcome.seen }));
        }
        return yield* Deferred.await(deferred);
      });

    return {
      collected: Ref.get(state).pipe(Effect.map((current) => current.items)),
      awaitItem,
      awaitDone: Deferred.await(finished),
      isDone: Ref.get(state).pipe(Effect.map((current) => current.done)),
    };
  });
