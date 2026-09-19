/**
 * Watching a live stream from a scenario, with a position in it.
 *
 * Every end-to-end scenario is a sequence of "do this, then that happened",
 * and the collector underneath resolves a wait from history as readily as from
 * the future — which is what lets it answer an event that has already
 * arrived. The cost is that "wait until nothing is pending" is answered by the
 * idle view from *before* the turn started unless the wait says where to look
 * from. So everything here is marked: `mark` is the position after what has
 * been seen, and every wait takes one.
 *
 * Three streams are watched this way — a thread, the sidebar list, and the
 * connection's own state — so the marking lives here once.
 */

import {
  applyThreadListItem,
  applyThreadStreamItem,
  type ThreadDetailView,
} from "@OpenAde/client-runtime/clientState";
import type { ConnectionState, OpenAdeRpcClient } from "@OpenAde/client-runtime/connection";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type {
  CommandReceipt,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * A position in a watched stream, for waits that mean "after this".
 *
 * Counted in values the watcher produced, not in event-log sequences: a
 * coalesced stream produces fewer values than the log has events, and what a
 * wait needs to skip is the values it has already been shown.
 */
export type ViewMark = number;

/** One value and where it sat in the sequence. */
interface Marked<A> {
  readonly index: ViewMark;
  readonly value: A;
}

export interface Watch<A> {
  /** Everything the watcher produced, in order. */
  readonly all: Effect.Effect<ReadonlyArray<A>>;
  /** The position after what has been seen; pass it to `await`. */
  readonly mark: Effect.Effect<ViewMark>;
  /** The most recent value. */
  readonly latest: Effect.Effect<A | undefined>;
  /** The first value at or after `after` satisfying `predicate`. */
  readonly awaitValue: (predicate: (value: A) => boolean, after?: ViewMark) => Effect.Effect<A>;
  /** The same, plus the position just after the value it matched. */
  readonly awaitAt: (
    predicate: (value: A) => boolean,
    after?: ViewMark,
  ) => Effect.Effect<{ readonly value: A; readonly next: ViewMark }>;
  /** Everything from `after` onwards — for "nothing happened in between". */
  readonly since: (after: ViewMark) => Effect.Effect<ReadonlyArray<A>>;
}

/**
 * Drains `stream` on a fiber bound to the current scope, numbering what it
 * produces. `what` names the stream in the failure message a wait that
 * outlives it raises — "the stream ended" says nothing on its own about which
 * wait was outstanding.
 */
const watch = <A, E, R>(
  what: string,
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<Watch<A>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ViewMark>(0);
    // A subscription whose socket goes away ends the watch; it does not fail
    // the scenario. Restarting the server under a client is a scenario in its
    // own right, and the server dying at teardown is every scenario's last
    // act — neither is a defect. The cause is kept so a wait that outlives the
    // stream can say which of the two it was.
    const ended = yield* Ref.make<string | null>(null);
    const numbered = stream.pipe(
      Stream.mapEffect((value) =>
        Ref.getAndUpdate(seen, (count) => count + 1).pipe(
          Effect.map((index): Marked<A> => ({ index, value })),
        ),
      ),
      Stream.catchCause((cause) =>
        Stream.unwrap(
          Ref.set(ended, Cause.pretty(cause).slice(0, 300)).pipe(Effect.as(Stream.empty)),
        ),
      ),
    );
    const collector = yield* makeStreamCollector(numbered);
    const awaitAt = (
      predicate: (value: A) => boolean,
      after: ViewMark = 0,
    ): Effect.Effect<{ readonly value: A; readonly next: ViewMark }> =>
      collector
        .awaitItem((marked) => marked.index >= after && predicate(marked.value))
        .pipe(
          Effect.map((marked) => ({ value: marked.value, next: marked.index + 1 })),
          Effect.catchTag("StreamEnded", (error) =>
            Ref.get(ended).pipe(
              Effect.flatMap((cause) =>
                Effect.die(
                  new Error(
                    `${what} ended after ${error.seen} values without one matching the wait (from mark ${after})${
                      cause === null ? "" : `; the stream failed with ${cause}`
                    }`,
                  ),
                ),
              ),
            ),
          ),
        );
    const all = collector.collected.pipe(Effect.map((values) => values.map((m) => m.value)));
    return {
      all,
      mark: Ref.get(seen),
      latest: all.pipe(Effect.map((values) => values.at(-1))),
      awaitValue: (predicate, after) =>
        awaitAt(predicate, after).pipe(Effect.map((matched) => matched.value)),
      awaitAt,
      since: (after) =>
        collector.collected.pipe(
          Effect.map((values) => values.filter((m) => m.index >= after).map((m) => m.value)),
        ),
    };
  });

// ── The thread, folded the way the renderer folds it ───────────

export interface ThreadWatch extends Watch<ThreadDetailView> {
  /**
   * Waits until the subscription has caught up with one command's own write,
   * and answers with the position just after the view that carried it.
   *
   * This is what `CommandReceipt.lastSequence` is for: it names the event-log
   * position the command's effects are visible at, so "the turn I just started
   * is on screen" is an exact question rather than a race.
   *
   * It answers with the position *past* that view, so it is the mark for what
   * happens next — not for the command's own event. A scenario asserting on
   * that event (a restore that is now running) takes a plain `mark` before
   * dispatching instead.
   */
  readonly markAfter: (receipt: CommandReceipt) => Effect.Effect<ViewMark>;
  /** The raw stream items, for assertions about delivery rather than state. */
  readonly items: Effect.Effect<ReadonlyArray<ThreadStreamItem>>;
}

/**
 * Subscribes to a thread and folds it exactly as `threadDetailAtom` does.
 *
 * The fold is the renderer's — `applyThreadStreamItem` from
 * `@OpenAde/client-runtime` — so a bug that would show as a wrong pane shows
 * here as a wrong view.
 */
export const watchThread = (
  rpc: Effect.Effect<OpenAdeRpcClient>,
  threadId: ThreadId,
): Effect.Effect<ThreadWatch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const raw = yield* Ref.make<ReadonlyArray<ThreadStreamItem>>([]);
    const doc = yield* Ref.make<ThreadDetailView | null>(null);
    const views = Stream.unwrap(
      Effect.map(rpc, (client) => client["threads.subscribe"]({ threadId })),
    ).pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          yield* Ref.update(raw, (all) => [...all, item]);
          if (item.kind === "resnapshot-required") {
            yield* Ref.set(doc, null);
          }
          return yield* Ref.updateAndGet(doc, (current) => applyThreadStreamItem(current, item));
        }),
      ),
      Stream.filter((view): view is ThreadDetailView => view !== null),
    );
    const base = yield* watch(`the thread subscription for ${threadId}`, views);
    return {
      ...base,
      markAfter: (receipt) =>
        base
          .awaitAt((view) => view.snapshotSequence >= receipt.lastSequence)
          .pipe(Effect.map((matched) => matched.next)),
      items: Ref.get(raw),
    };
  });

/** The sidebar's own subscription, folded with the sidebar's own reducer. */
export const watchThreadList = (
  rpc: Effect.Effect<OpenAdeRpcClient>,
  projectId: ProjectId,
): Effect.Effect<Watch<ReadonlyArray<ThreadSummary>>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<ThreadSummary>>([]);
    const lists = Stream.unwrap(
      Effect.map(rpc, (client) => client["threads.listSubscribe"]({ projectId })),
    ).pipe(
      Stream.mapEffect((item) =>
        Ref.updateAndGet(state, (threads) => applyThreadListItem(threads, item)),
      ),
    );
    return yield* watch(`the thread list for ${projectId}`, lists);
  });

/** The connection's own state — what the reconnecting banner reads. */
export const watchConnection = (
  state: SubscriptionRef.SubscriptionRef<ConnectionState>,
): Effect.Effect<Watch<ConnectionState>, never, Scope.Scope> =>
  watch("the connection state", SubscriptionRef.changes(state));
