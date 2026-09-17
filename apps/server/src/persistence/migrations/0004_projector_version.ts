import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The projector version a set of projection rows was written by.
 *
 * `threads.doc_json` is parsed straight back into a `ThreadDoc` with no schema
 * and no version, so the first release that adds a field to that document
 * would read stale rows back and serve snapshots missing it. Stamping the
 * version the rows were written by gives the engine something to compare
 * against at boot, and `0` for rows written before this column existed is
 * exactly right: they are stale by definition.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_state
    ADD COLUMN projector_version INTEGER NOT NULL DEFAULT 0
  `;
});
