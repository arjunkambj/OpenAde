/**
 * Waiting for a command to land, without waiting on a clock.
 *
 * Every write in OpenAde is a command, and every command comes back as a
 * `CommandReceipt` carrying the event-log position its effects are visible at.
 * That makes "did my write happen?" answerable exactly, so no test in this
 * repository ever sleeps to find out: it records receipts as they arrive and
 * awaits the one it cares about by `commandId`.
 *
 * The same shape works for any stream — a thread subscription, a settings
 * subscription — through `collectUntil` and the underlying stream collector.
 */

import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import type { StreamEnded } from "@OpenAde/connector-sdk/streamCollector";
import type { CommandId } from "@OpenAde/contracts/ids";
import type { CommandReceipt } from "@OpenAde/contracts/orchestration";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface ReceiptRecorder {
  /** Hand a receipt to the recorder, wherever it came from. */
  readonly record: (receipt: CommandReceipt) => Effect.Effect<void>;
  /**
   * Resolves with the receipt for `commandId` — immediately if it has already
   * been recorded, otherwise the moment it is. Fails rather than hangs once the
   * recorder is closed and the receipt never came.
   */
  readonly awaitReceipt: (commandId: CommandId) => Effect.Effect<CommandReceipt, StreamEnded>;
  readonly recorded: Effect.Effect<ReadonlyArray<CommandReceipt>>;
  /** Releases anything still waiting; called for you when the scope closes. */
  readonly close: Effect.Effect<void>;
}

/**
 * A recorder bound to the current scope. Receipts go in through `record` from
 * wherever the test gets them — an RPC result, a reactor, a fake — so it works
 * the same whether the server is real or not.
 */
export const makeReceiptRecorder: Effect.Effect<ReceiptRecorder, never, Scope.Scope> = Effect.gen(
  function* () {
    const queue = yield* Queue.make<CommandReceipt, Cause.Done>({ capacity: 1024 });
    const collector = yield* makeStreamCollector(Stream.fromQueue(queue));
    const close = Queue.end(queue).pipe(Effect.asVoid);
    yield* Effect.addFinalizer(() => close);

    return {
      record: (receipt) => Queue.offer(queue, receipt).pipe(Effect.asVoid),
      awaitReceipt: (commandId) =>
        collector.awaitItem((receipt) => receipt.commandId === commandId),
      recorded: collector.collected,
      close,
    };
  },
);

/** Awaits one receipt on a stream of them, for callers that already have a stream. */
export const awaitReceiptFrom = <E, R>(
  receipts: Stream.Stream<CommandReceipt, E, R>,
  commandId: CommandId,
): Effect.Effect<CommandReceipt, StreamEnded, R | Scope.Scope> =>
  makeStreamCollector(receipts).pipe(
    Effect.flatMap((collector) =>
      collector.awaitItem((receipt) => receipt.commandId === commandId),
    ),
  );

/**
 * Everything a stream produces up to and including the first item matching
 * `predicate`. Use it when the end of the interesting part is a value on the
 * stream rather than the end of the stream itself.
 */
export const collectUntil = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  predicate: (item: A) => boolean,
): Effect.Effect<ReadonlyArray<A>, E, R> => Stream.runCollect(Stream.takeUntil(stream, predicate));
