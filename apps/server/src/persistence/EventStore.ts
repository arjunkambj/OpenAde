/**
 * The event log: append-only `events` plus `command_receipts`.
 *
 * `append` assigns `stream_version` per aggregate and relies on the
 * `UNIQUE (stream_kind, stream_id, stream_version)` index as the
 * optimistic-concurrency backstop — the engine serialises writers, so a
 * violation means a bug, not contention, and surfaces as
 * `ConcurrencyConflict`.
 *
 * Every method runs inside whichever transaction is ambient, which is what
 * makes "events, projections and the receipt commit in one transaction" true.
 */

import type { CommandId } from "@OpenAde/contracts/ids";
import type { CommandReceipt, StreamKind } from "@OpenAde/contracts/orchestration";
import { OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { layer as migrationsLayer } from "./Migrations";

/** `Omit` that distributes over a union, so each variant keeps its payload. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * An event the decider or ingestion produced, before the log assigns a
 * position. The distributive `Omit` keeps the union — `type` still correlates
 * with `payload`.
 */
export type PlannedEvent = DistributiveOmit<OrchestrationEvent, "sequence" | "streamVersion">;

/** A second writer appended to a stream the first had already read. */
export class ConcurrencyConflict extends Data.TaggedError("ConcurrencyConflict")<{
  readonly streamKind: StreamKind;
  readonly streamId: string;
}> {}

export type EventStoreError = SqlError | ConcurrencyConflict;

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly stream_kind: string;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly type: string;
  readonly occurred_at: string;
  readonly command_id: string | null;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
  readonly actor: string;
  readonly payload_json: string;
}

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const rowToEvent = (row: EventRow): OrchestrationEvent =>
  decodeEvent({
    sequence: row.sequence,
    eventId: row.event_id,
    streamKind: row.stream_kind,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    type: row.type,
    occurredAt: row.occurred_at,
    actor: row.actor,
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    ...(row.causation_event_id === null ? {} : { causationEventId: row.causation_event_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    payload: JSON.parse(row.payload_json),
  });

const EVENT_COLUMNS = `
  sequence, event_id, stream_kind, stream_id, stream_version, type,
  occurred_at, command_id, causation_event_id, correlation_id, actor,
  payload_json
`;

export class EventStore extends Context.Service<
  EventStore,
  {
    /** All events of one aggregate, in stream order. */
    readonly loadStream: (
      streamKind: StreamKind,
      streamId: string,
    ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, SqlError>;
    /** Events of one aggregate with `sequence` greater than `after`. */
    readonly streamAfter: (
      streamKind: StreamKind,
      streamId: string,
      after: number,
    ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, SqlError>;
    /** Every thread-stream event after `after`, for list subscriptions. */
    readonly threadEventsAfter: (
      after: number,
    ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, SqlError>;
    /** Appends planned events; returns them with `sequence` and `streamVersion` assigned. */
    readonly append: (
      streamKind: StreamKind,
      streamId: string,
      planned: ReadonlyArray<PlannedEvent>,
    ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, EventStoreError>;
    /** The highest `sequence` written so far; `0` on an empty log. */
    readonly lastSequence: Effect.Effect<number, SqlError>;
    /** The stored receipt for `commandId`, if this command already ran. */
    readonly receipt: (commandId: CommandId) => Effect.Effect<CommandReceipt | null, SqlError>;
    /** Persists a receipt inside the same transaction as the command's effects. */
    readonly recordReceipt: (
      receipt: CommandReceipt,
      createdAt: string,
    ) => Effect.Effect<void, SqlError>;
  }
>()("server/persistence/EventStore") {
  static readonly layer = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const loadStream = (streamKind: StreamKind, streamId: string) =>
        sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
          WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
          ORDER BY stream_version
        `.pipe(Effect.map((rows) => rows.map(rowToEvent)));

      const streamAfter = (streamKind: StreamKind, streamId: string, after: number) =>
        sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
          WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
            AND sequence > ${after}
          ORDER BY sequence
        `.pipe(Effect.map((rows) => rows.map(rowToEvent)));

      const threadEventsAfter = (after: number) =>
        sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
          WHERE stream_kind = 'thread' AND sequence > ${after}
          ORDER BY sequence
        `.pipe(Effect.map((rows) => rows.map(rowToEvent)));

      const append = (
        streamKind: StreamKind,
        streamId: string,
        planned: ReadonlyArray<PlannedEvent>,
      ) =>
        Effect.gen(function* () {
          if (planned.length === 0) {
            return [] as ReadonlyArray<OrchestrationEvent>;
          }
          const versionRows = yield* sql<{ readonly v: number }>`
            SELECT COALESCE(MAX(stream_version), 0) AS v
            FROM events
            WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
          `;
          const base = versionRows[0]?.v ?? 0;
          const appended: Array<OrchestrationEvent> = [];
          for (const [index, event] of planned.entries()) {
            const streamVersion = base + index + 1;
            const inserted = yield* sql<{ readonly sequence: number }>`
              INSERT INTO events (
                event_id, stream_kind, stream_id, stream_version, type,
                occurred_at, command_id, causation_event_id, correlation_id,
                actor, payload_json
              ) VALUES (
                ${event.eventId}, ${streamKind}, ${streamId}, ${streamVersion},
                ${event.type}, ${event.occurredAt},
                ${event.commandId ?? null},
                ${event.causationEventId ?? null},
                ${event.correlationId ?? null},
                ${event.actor}, ${JSON.stringify(event.payload)}
              )
              RETURNING sequence
            `.pipe(
              Effect.mapError((error) =>
                error.reason._tag === "UniqueViolation"
                  ? new ConcurrencyConflict({ streamKind, streamId })
                  : error,
              ),
            );
            appended.push({
              ...event,
              streamVersion,
              sequence: inserted[0]?.sequence ?? 0,
            });
          }
          return appended;
        });

      const lastSequence = sql<{ readonly v: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS v FROM events
      `.pipe(Effect.map((rows) => rows[0]?.v ?? 0));

      const receipt = (commandId: CommandId) =>
        sql<{
          readonly status: string;
          readonly reason: string | null;
          readonly last_sequence: number;
        }>`
          SELECT status, reason, last_sequence FROM command_receipts
          WHERE command_id = ${commandId}
        `.pipe(
          Effect.map((rows): CommandReceipt | null =>
            rows.length === 0
              ? null
              : {
                  commandId,
                  status: rows[0]?.status === "rejected" ? "rejected" : "accepted",
                  ...(rows[0]?.reason === null || rows[0]?.reason === undefined
                    ? {}
                    : { reason: rows[0].reason }),
                  lastSequence: rows[0]?.last_sequence ?? 0,
                },
          ),
        );

      const recordReceipt = (commandReceipt: CommandReceipt, createdAt: string) =>
        sql`
          INSERT INTO command_receipts
            (command_id, status, reason, last_sequence, created_at)
          VALUES (
            ${commandReceipt.commandId}, ${commandReceipt.status},
            ${commandReceipt.reason ?? null}, ${commandReceipt.lastSequence},
            ${createdAt}
          )
        `.pipe(Effect.asVoid);

      return EventStore.of({
        loadStream,
        streamAfter,
        threadEventsAfter,
        append,
        lastSequence,
        receipt,
        recordReceipt,
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}
