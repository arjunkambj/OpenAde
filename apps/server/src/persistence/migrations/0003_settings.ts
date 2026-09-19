import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `settings` holds small keyed documents (`SettingsStore` writes the main
 * document here). `permission_rules` is its own table rather than a JSON blob
 * because the permission engine filters it by scope on every tool call, and
 * because "allow always" appends a row from the approval flow.
 *
 * `project_id`/`thread_id` are `''` rather than NULL when unset so the UNIQUE
 * constraint actually dedupes — SQLite never considers NULL equal to NULL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE permission_rules (
      rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      pattern TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (scope, project_id, thread_id, pattern)
    )
  `;
});
