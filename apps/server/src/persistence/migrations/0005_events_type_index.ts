import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An index on `events(type, sequence)`.
 *
 * The checkpoint reactor's boot replay looked for outstanding restore orders by
 * reading — and schema-decoding — every thread event ever written, inside the
 * layer build, before the server writes its handshake. The desktop supervisor
 * kills a child that has not handshaken in 15 seconds and gives up after five
 * such kills, and the timeout does not grow, so a log big enough to take longer
 * than that made the app permanently unstartable over data that was perfectly
 * intact. Restores are rare: with this index the reactor asks for the four
 * event types it actually cares about and reads a handful of rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_events_type_sequence
    ON events (type, sequence)
  `;
});
