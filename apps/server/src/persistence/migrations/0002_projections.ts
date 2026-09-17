import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The read-model tables.
 *
 * `projects` and `threads` are the sidebar's rows. A thread's full detail — the
 * `ThreadDetailSnapshot` the wire sends — is kept as a JSON document in
 * `doc_json`: the snapshot is the projection, so storing it whole makes the
 * snapshot read a single row fetch and keeps replay a pure fold.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_threads_project
    ON threads(project_id)
  `;

  yield* sql`
    CREATE INDEX idx_threads_status
    ON threads(status)
  `;
});
