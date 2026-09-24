import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Widens a saved `threadOpen` clause on the three dock keys to the one they
 * default to now, so they answer on the New task page as well as beside a
 * thread.
 *
 * The dock keys defaulted to `when: threadOpen`, and the keybindings editor
 * keeps a row's clause when the user rebinds its chord, so a user who moved
 * `dock.toggle`, `dock.changes` or `dock.files` to another chord stored an
 * override with that clause — one that would keep the key dead on the New
 * task page, whose dock now answers them under `threadOpen || newTaskOpen`.
 * This rewrites exactly those rows: one of the three commands, with a clause
 * that is exactly `threadOpen`. Any other clause is the user's own and is
 * left alone, as are every other command's rows, an unbind row (`-dock.…`),
 * a document this build cannot parse (the settings store's unreadable-row
 * path owns that) and a fresh install. Because it runs once, a user who
 * later narrows a dock key back to `threadOpen` keeps it narrowed.
 *
 * The values are written out here rather than read from the contracts'
 * defaults: a migration must do the same thing forever, whatever the defaults
 * become.
 */

const DOCK_COMMANDS = new Set(["dock.toggle", "dock.changes", "dock.files"]);
const OLD_CLAUSE = "threadOpen";
const NEW_CLAUSE = "threadOpen || newTaskOpen";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The document with the dock rows widened, or null when nothing changes. */
const withDockKeysOnNewTask = (raw: string): string | null => {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(stored) || !Array.isArray(stored.keybindings)) {
    return null;
  }
  let changed = false;
  const keybindings = stored.keybindings.map((row: unknown) => {
    if (
      isRecord(row) &&
      typeof row.command === "string" &&
      DOCK_COMMANDS.has(row.command) &&
      row.when === OLD_CLAUSE
    ) {
      changed = true;
      return { ...row, when: NEW_CLAUSE };
    }
    return row;
  });
  return changed ? JSON.stringify({ ...stored, keybindings }) : null;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ readonly value_json: string }>`
    SELECT value_json FROM settings WHERE key = 'settings'
  `;
  const raw = rows[0]?.value_json;
  const next = raw === undefined ? null : withDockKeysOnNewTask(raw);
  if (next === null) {
    return;
  }
  yield* sql`
    UPDATE settings
    SET value_json = ${next}, updated_at = ${new Date().toISOString()}
    WHERE key = 'settings'
  `;
});
