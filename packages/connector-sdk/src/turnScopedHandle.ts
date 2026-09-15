/**
 * Correlating a harness's events with one of our turns.
 *
 * A harness numbers its own turns, or does not number them at all; the server
 * numbers turns with a `TurnId` it minted before the process was even spawned.
 * This wrapper is the single place allowed to join the two. Everything it does
 * follows from three rules the orchestration engine depends on:
 *
 *  1. While a turn is active, every event belongs to it. Envelopes are stamped
 *     with our `turnId`, so a projection never has to guess.
 *  2. A turn always ends. If the harness's event stream ends — the process died,
 *     the pipe closed — while a turn is unsettled, a `turn.completed` with
 *     `stopReason: "error"` is synthesized, because a thread stuck in `running`
 *     with no process behind it is unrecoverable from the UI.
 *  3. Turns do not overlap. A second `send` for a different turn is refused with
 *     `TurnInProgress` rather than silently superseding the first.
 *
 * Semantics follow zuse's `kernel/turn-protocol.ts`, adapted to our flat
 * `RuntimeEvent` union: it uses a scope/envelope split, we tag the envelope.
 */

import { makeEventId } from "@OpenAde/contracts/ids";
import type { ConnectorInstanceId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { RuntimeEvent, TurnStopReason } from "@OpenAde/contracts/runtime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ConnectorError, TurnInput } from "./definition";
import { TurnInProgress } from "./definition";
import type { SessionHandle } from "./sessionHandle";

/**
 * A handle whose `send` carries the turn it starts. Everything else is the
 * underlying handle's, unchanged.
 */
export interface TurnScopedSessionHandle extends Omit<SessionHandle, "events" | "send"> {
  readonly events: Stream.Stream<RuntimeEvent>;
  /**
   * Starts `turnId`. Calling it again for the same turn is a no-op, so a retry
   * after a lost receipt does not send the prompt twice; calling it for a
   * different turn while one is active fails with `TurnInProgress`.
   */
  readonly send: (turnId: TurnId, turn: TurnInput) => Effect.Effect<void, ConnectorError>;
  /** The turn currently unsettled, if any. */
  readonly activeTurnId: Effect.Effect<TurnId | null>;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly released: Deferred.Deferred<void>;
}

/**
 * What one incoming event turns into. Synthesized completions are described
 * rather than built inside the atomic state update, because minting an event id
 * and reading the clock are effects and the state update must not be one.
 */
type Emission =
  | { readonly kind: "passthrough"; readonly event: RuntimeEvent }
  | { readonly kind: "tagged"; readonly event: RuntimeEvent; readonly turnId: TurnId }
  | { readonly kind: "completion"; readonly turnId: TurnId; readonly stopReason: TurnStopReason };

interface Batch {
  readonly emissions: ReadonlyArray<Emission>;
  readonly released: Deferred.Deferred<void> | null;
}

const EMPTY_BATCH: Batch = { emissions: [], released: null };

/** A session that ends mid-turn ends the turn the same way it ended the session. */
const stopReasonForSessionEnd = (reason: string): TurnStopReason =>
  reason === "interrupted" ? "interrupted" : "error";

export interface TurnScopedHandleOptions {
  readonly connectorInstanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
}

export const makeTurnScopedHandle = (
  handle: SessionHandle,
  options: TurnScopedHandleOptions,
): Effect.Effect<TurnScopedSessionHandle> =>
  Effect.gen(function* () {
    const activeRef = yield* Ref.make<ActiveTurn | null>(null);

    const synthesize = (turnId: TurnId, stopReason: TurnStopReason): Effect.Effect<RuntimeEvent> =>
      Clock.currentTimeMillis.pipe(
        Effect.map((millis) => ({
          eventId: makeEventId(),
          connectorInstanceId: options.connectorInstanceId,
          threadId: options.threadId,
          createdAt: new Date(millis).toISOString(),
          turnId,
          type: "turn.completed" as const,
          payload: { turnId, stopReason },
        })),
      );

    const materialize = (batch: Batch): Effect.Effect<ReadonlyArray<RuntimeEvent>> =>
      Effect.gen(function* () {
        const events: Array<RuntimeEvent> = [];
        for (const emission of batch.emissions) {
          if (emission.kind === "completion") {
            events.push(yield* synthesize(emission.turnId, emission.stopReason));
          } else if (emission.kind === "tagged") {
            events.push({ ...emission.event, turnId: emission.turnId });
          } else {
            events.push(emission.event);
          }
        }
        if (batch.released !== null) {
          yield* Deferred.succeed(batch.released, undefined);
        }
        return events;
      });

    const normalize = (event: RuntimeEvent): Effect.Effect<ReadonlyArray<RuntimeEvent>> =>
      Ref.modify(activeRef, (active): readonly [Batch, ActiveTurn | null] => {
        if (active === null) {
          return [{ emissions: [{ kind: "passthrough", event }], released: null }, null];
        }
        if (event.type === "turn.completed") {
          return [
            {
              emissions: [{ kind: "tagged", event, turnId: active.turnId }],
              released: active.released,
            },
            null,
          ];
        }
        if (event.type === "session.ended") {
          return [
            {
              emissions: [
                {
                  kind: "completion",
                  turnId: active.turnId,
                  stopReason: stopReasonForSessionEnd(event.payload.reason),
                },
                { kind: "passthrough", event },
              ],
              released: active.released,
            },
            null,
          ];
        }
        return [
          { emissions: [{ kind: "tagged", event, turnId: active.turnId }], released: null },
          active,
        ];
      }).pipe(Effect.flatMap(materialize));

    const finalize: Effect.Effect<ReadonlyArray<RuntimeEvent>> = Ref.modify(
      activeRef,
      (active): readonly [Batch, ActiveTurn | null] =>
        active === null
          ? [EMPTY_BATCH, null]
          : [
              {
                emissions: [{ kind: "completion", turnId: active.turnId, stopReason: "error" }],
                released: active.released,
              },
              null,
            ],
    ).pipe(Effect.flatMap(materialize));

    const events = handle.events.pipe(
      Stream.mapEffect(normalize),
      Stream.flatMap(Stream.fromIterable),
      Stream.concat(Stream.fromEffect(finalize).pipe(Stream.flatMap(Stream.fromIterable))),
    );

    /** Drops `turnId` if it is still the active one, releasing anyone waiting on it. */
    const abandon = (turnId: TurnId): Effect.Effect<void> =>
      Ref.modify(activeRef, (active): readonly [ActiveTurn | null, ActiveTurn | null] =>
        active !== null && active.turnId === turnId ? [active, null] : [null, active],
      ).pipe(
        Effect.flatMap((dropped) =>
          dropped === null ? Effect.void : Deferred.succeed(dropped.released, undefined),
        ),
        Effect.asVoid,
      );

    const send = (turnId: TurnId, turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        const decision = yield* Ref.modify(
          activeRef,
          (
            active,
          ): readonly [
            { readonly kind: "send" | "duplicate" | "busy"; readonly activeTurnId: TurnId | null },
            ActiveTurn | null,
          ] => {
            if (active === null) {
              return [
                { kind: "send", activeTurnId: turnId },
                { turnId, released },
              ];
            }
            return active.turnId === turnId
              ? [{ kind: "duplicate", activeTurnId: turnId }, active]
              : [{ kind: "busy", activeTurnId: active.turnId }, active];
          },
        );

        if (decision.kind === "busy") {
          return yield* Effect.fail(
            new TurnInProgress({
              threadId: options.threadId,
              activeTurnId: decision.activeTurnId,
            }),
          );
        }
        if (decision.kind === "duplicate") {
          return;
        }
        yield* handle.send(turn).pipe(Effect.tapError(() => abandon(turnId)));
      });

    return {
      ...handle,
      events,
      send,
      activeTurnId: Ref.get(activeRef).pipe(Effect.map((active) => active?.turnId ?? null)),
    };
  });
