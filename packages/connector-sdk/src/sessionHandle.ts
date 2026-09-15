/**
 * The live surface of one connector session — one per thread.
 *
 * Everything the server does to a running harness goes through this interface,
 * and everything the harness says comes back on `events`. The stream is bounded
 * on purpose: a harness that floods (a `yes` loop in a shell tool, a runaway
 * diff) must not grow the server's heap, and dropping ordinary chatter is far
 * better than dropping the `turn.completed` that tells the engine the turn is
 * over. `makeBoundedEventQueue` is what buys that: a 2048-slot queue whose last
 * 64 slots only terminal events may use.
 */

import type { ApprovalDecision } from "@OpenAde/contracts/enums";
import type { RequestId, TurnId } from "@OpenAde/contracts/ids";
import type { PlanResponseAction, ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { RuntimeEvent, UserQuestionAnswer } from "@OpenAde/contracts/runtime";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ConnectorError, TurnInput } from "./definition";

/**
 * One connector session.
 *
 * `send` fails with `TurnInProgress` when a turn is already running and the
 * connector's `capabilities.steering` is false — Command Code's print mode is
 * one turn per process, so a second message has to be queued by the caller
 * rather than raced into the running one.
 *
 * `close` is not best-effort: it resolves only once the connector has proved
 * the process tree it started is gone. A connector that cannot prove that must
 * fail rather than pretend.
 */
export interface SessionHandle {
  readonly events: Stream.Stream<RuntimeEvent>;
  readonly send: (turn: TurnInput) => Effect.Effect<void, ConnectorError>;
  readonly interrupt: () => Effect.Effect<void, ConnectorError>;
  readonly respondToRequest: (
    requestId: RequestId,
    decision: ApprovalDecision,
    updatedInput?: unknown,
  ) => Effect.Effect<void, ConnectorError>;
  readonly respondToUserInput: (
    requestId: RequestId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void, ConnectorError>;
  readonly respondToPlan: (
    turnId: TurnId,
    action: PlanResponseAction,
    feedback?: string,
  ) => Effect.Effect<void, ConnectorError>;
  readonly updateSettings: (patch: ThreadSettingsPatch) => Effect.Effect<void, ConnectorError>;
  readonly sessionRef: () => Effect.Effect<unknown, ConnectorError>;
  readonly close: () => Effect.Effect<void>;
}

// ── The bounded event queue ────────────────────────────────────

/** Slots in one session's event buffer (spec section 7). */
export const EVENT_QUEUE_CAPACITY = 2048;

/** Of those slots, how many are kept back for terminal events. */
export const TERMINAL_EVENT_RESERVE = 64;

/**
 * Events that end something and therefore may use the reserve. Losing one of
 * these strands a turn in `running` forever, which is the one failure the
 * buffer must never produce; losing an `item.updated` only costs a redraw.
 */
export const TERMINAL_EVENT_TYPES: ReadonlySet<RuntimeEvent["type"]> = new Set<
  RuntimeEvent["type"]
>(["turn.completed", "session.ended", "runtime.error"]);

export const isTerminalEvent = (event: RuntimeEvent): boolean =>
  TERMINAL_EVENT_TYPES.has(event.type);

export interface BoundedEventQueue {
  /** The session's event stream. Finishes when `end` is called. */
  readonly events: Stream.Stream<RuntimeEvent>;
  /** Offers one event; `false` means it was dropped because the buffer was full. */
  readonly offer: (event: RuntimeEvent) => Effect.Effect<boolean>;
  /** Closes the stream. Events already buffered are still delivered. */
  readonly end: Effect.Effect<void>;
  /** How many events have been dropped, for `session.warning` and for tests. */
  readonly dropped: Effect.Effect<number>;
}

/**
 * A dropping queue with a reserve: ordinary events are refused once the buffer
 * is within `reserve` slots of full, terminal events may use those last slots.
 * Offering never suspends, so a connector's parser fiber can never be blocked
 * by a slow consumer — it loses chatter instead, and says how much through
 * `dropped`.
 */
export const makeBoundedEventQueue = (options?: {
  readonly capacity?: number;
  readonly reserve?: number;
}): Effect.Effect<BoundedEventQueue> =>
  Effect.gen(function* () {
    const capacity = options?.capacity ?? EVENT_QUEUE_CAPACITY;
    const reserve = options?.reserve ?? TERMINAL_EVENT_RESERVE;
    const ordinaryLimit = Math.max(0, capacity - reserve);
    const queue = yield* Queue.make<RuntimeEvent, Cause.Done>({
      capacity,
      strategy: "dropping",
    });
    const droppedRef = yield* Ref.make(0);

    const offer = (event: RuntimeEvent): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const buffered = yield* Queue.size(queue);
        if (!isTerminalEvent(event) && buffered >= ordinaryLimit) {
          yield* Ref.update(droppedRef, (count) => count + 1);
          return false;
        }
        const accepted = yield* Queue.offer(queue, event);
        if (!accepted) {
          yield* Ref.update(droppedRef, (count) => count + 1);
        }
        return accepted;
      });

    return {
      events: Stream.fromQueue(queue),
      offer,
      end: Queue.end(queue).pipe(Effect.asVoid),
      dropped: Ref.get(droppedRef),
    };
  });
