import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Binds `terminal.toggle` to `Cmd+J` in a keybinding table that was saved
 * before the terminal existed.
 *
 * A stored table with any row is authoritative, so a new default never reaches
 * someone who has saved settings once. This appends the binding a single time,
 * and only when it cannot collide with anything: no stored document, one this
 * build cannot parse (the settings store's unreadable-row path owns that), an
 * empty table (the renderer already falls back to the defaults), a table that
 * binds the command already, or one where `Cmd+J` does something else — all are
 * left exactly as they are. Because it runs once, a user who later removes the
 * binding keeps it removed.
 *
 * The values are written out here rather than read from the contracts'
 * defaults: a migration must do the same thing forever, whatever the defaults
 * become.
 */

const COMMAND = "terminal.toggle";
const SHORTCUT = "Cmd+J";

/** The spellings of the platform modifier the table accepts, lowercased. */
const PLATFORM_MODIFIERS = new Set(["Cmd", "Mod", "Meta"].map((name) => name.toLowerCase()));

/** ` cmd + j `, `Mod+J` and `Meta+j` are all the chord the table writes `Cmd+J`. */
const chordOf = (shortcut: string): string =>
  shortcut
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .map((part) => (PLATFORM_MODIFIERS.has(part) ? "mod" : part))
    .sort()
    .join("+");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The document with the binding appended, or null when it must stay as it is. */
const withTerminalToggle = (raw: string): string | null => {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(stored)) {
    return null;
  }
  const table = stored.keybindings;
  if (!Array.isArray(table) || table.length === 0) {
    return null;
  }
  const taken = chordOf(SHORTCUT);
  for (const row of table) {
    if (!isRecord(row)) {
      continue;
    }
    if (row.command === COMMAND) {
      return null;
    }
    if (typeof row.shortcut === "string" && chordOf(row.shortcut) === taken) {
      return null;
    }
  }
  return JSON.stringify({
    ...stored,
    keybindings: [...table, { command: COMMAND, shortcut: SHORTCUT }],
  });
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ readonly value_json: string }>`
    SELECT value_json FROM settings WHERE key = 'settings'
  `;
  const raw = rows[0]?.value_json;
  const next = raw === undefined ? null : withTerminalToggle(raw);
  if (next === null) {
    return;
  }
  yield* sql`
    UPDATE settings
    SET value_json = ${next}, updated_at = ${new Date().toISOString()}
    WHERE key = 'settings'
  `;
});
