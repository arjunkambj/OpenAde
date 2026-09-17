import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The event-sourcing core: an append-only `events` table is the source of truth;
 * everything else is a projection of it.
 *
 * - `sequence` (INTEGER PK AUTOINCREMENT) is the global monotonic cursor — the
 *   unit of client resume (`afterSequence`) and of the projection watermark.
 * - `stream_version` is a per-stream 1..N counter enforced by the composite
 *   unique index — the optimistic-concurrency guard for appends.
 * - `command_receipts` makes dispatch idempotent: a retried `commandId` returns
 *   its stored receipt instead of re-deciding.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      stream_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (stream_kind, stream_id, stream_version)
    )
  `;

  yield* sql`
    CREATE INDEX idx_events_stream
    ON events(stream_kind, stream_id, sequence)
  `;

  yield* sql`
    CREATE INDEX idx_events_command_id
    ON events(command_id)
  `;

  yield* sql`
    CREATE INDEX idx_events_correlation_id
    ON events(correlation_id)
  `;

  yield* sql`
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT,
      last_sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
