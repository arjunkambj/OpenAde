/**
 * The shipped keymap, and how a user's overrides are layered on it.
 *
 * The settings document stores only what the user changed
 * (`Settings.keybindings`), never a copy of the defaults — a copy would pin an
 * install to the defaults of the build that wrote it, and a shortcut added
 * later would never reach it. The rule is per command:
 *
 * - When the overrides mention a command at all, that command's default rows
 *   are dropped and its override rows are its bindings.
 * - A row whose command is `-X` (the VS Code convention) mentions `X` without
 *   binding it, so on its own it unbinds `X`. Its `shortcut` is `X`'s old
 *   chord, kept only so the stored row still reads as what was removed.
 * - The effective table is the override rows first, then the defaults of every
 *   command the overrides do not mention, in default order. Resolution is
 *   first-match, so an override shadows another command's default on the same
 *   chord.
 * - An override for a command the defaults do not know is kept; it is inert
 *   until something registers that command.
 */

import type { Keybinding } from "./settings";

/**
 * The server-owned defaults. The keybindings page shows these as the baseline a
 * user's overrides are diffed against, so the list is the contract, not a
 * renderer constant. A row added here reaches every install, because the
 * stored document holds only overrides.
 */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = [
  { command: "thread.new", shortcut: "Cmd+N" },
  { command: "commandPalette.toggle", shortcut: "Cmd+K" },
  { command: "composer.queue", shortcut: "Cmd+Enter" },
  { command: "thread.interrupt", shortcut: "Escape" },
  { command: "browserPane.toggle", shortcut: "Cmd+Shift+B" },
  { command: "sidebar.toggle", shortcut: "Cmd+B" },
  { command: "skills.open", shortcut: "Cmd+Shift+S" },
  { command: "settings.open", shortcut: "Cmd+," },
];

/**
 * The table every install stored before the document held overrides — the
 * defaults of that build, verbatim. Frozen: it describes what old documents
 * contain, so it must never follow a change to `DEFAULT_KEYBINDINGS`.
 */
export const LEGACY_DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = Object.freeze([
  { command: "thread.new", shortcut: "Cmd+N" },
  { command: "commandPalette.toggle", shortcut: "Cmd+K" },
  { command: "composer.queue", shortcut: "Cmd+Enter" },
  { command: "thread.interrupt", shortcut: "Escape" },
  { command: "browserPane.toggle", shortcut: "Cmd+Shift+B" },
  { command: "sidebar.toggle", shortcut: "Cmd+B" },
  { command: "skills.open", shortcut: "Cmd+Shift+S" },
  { command: "settings.open", shortcut: "Cmd+," },
  // Appended to stored tables by the 0006_terminal_keybinding migration.
  { command: "terminal.toggle", shortcut: "Cmd+J" },
]);

const UNBIND_PREFIX = "-";

/** True for a `-X` row: it unbinds `X` rather than binding anything. */
export const isUnbindRow = (row: Keybinding): boolean =>
  row.command.length > UNBIND_PREFIX.length && row.command.startsWith(UNBIND_PREFIX);

/** The command a row is about — `X` for both an `X` row and a `-X` row. */
const subjectOf = (row: Keybinding): string =>
  isUnbindRow(row) ? row.command.slice(UNBIND_PREFIX.length) : row.command;

/** A row with no `when: undefined` key, so it compares and stores cleanly. */
const clean = (row: Keybinding): Keybinding =>
  row.when === undefined
    ? { command: row.command, shortcut: row.shortcut }
    : { command: row.command, shortcut: row.shortcut, when: row.when };

const sameRow = (a: Keybinding, b: Keybinding): boolean =>
  a.command === b.command && a.shortcut === b.shortcut && a.when === b.when;

const sameRows = (a: ReadonlyArray<Keybinding>, b: ReadonlyArray<Keybinding>): boolean =>
  a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));

/** Rows grouped by command, in order of first appearance. */
const byCommand = (table: ReadonlyArray<Keybinding>): Map<string, Array<Keybinding>> => {
  const groups = new Map<string, Array<Keybinding>>();
  for (const row of table) {
    const group = groups.get(row.command);
    if (group === undefined) {
      groups.set(row.command, [row]);
    } else {
      group.push(row);
    }
  }
  return groups;
};

/** The one row that unbinds `command`, carrying its old chord for display. */
const unbindRow = (command: string, shortcut: string): Keybinding => ({
  command: `${UNBIND_PREFIX}${command}`,
  shortcut,
});

/**
 * The table to dispatch against: the override rows (removals excluded) first,
 * then the defaults of every command the overrides do not mention.
 */
export const resolveKeymap = (
  defaults: ReadonlyArray<Keybinding>,
  overrides: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  const overridden = new Set(overrides.map(subjectOf));
  return [
    ...overrides.filter((row) => !isUnbindRow(row)).map(clean),
    ...defaults.filter((row) => !overridden.has(row.command)),
  ];
};

/**
 * The overrides that turn `defaults` into `effective` — what the editor saves.
 * A command whose rows equal its defaults emits nothing, one whose rows differ
 * emits all of them, and a default command left with no rows emits one `-X`
 * row. Order within a command is kept; order across commands is not, since
 * `resolveKeymap` always puts overrides first.
 */
export const diffKeymap = (
  defaults: ReadonlyArray<Keybinding>,
  effective: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  const shipped = byCommand(defaults);
  const wanted = byCommand(effective.map(clean));
  const changed = [...wanted].flatMap(([command, rows]) => {
    const baseline = shipped.get(command);
    return baseline !== undefined && sameRows(rows, baseline) ? [] : rows;
  });
  const removed = [...shipped]
    .filter(([command]) => !wanted.has(command))
    .map(([command, rows]) => unbindRow(command, rows[0]!.shortcut));
  return [...changed, ...removed];
};

/**
 * Turns a full table stored before the document held overrides into
 * overrides. Rows are compared by exact string equality, which is sound
 * because the recorder always wrote the canonical `Cmd+…` form.
 *
 * - A legacy command whose rows are exactly its legacy default gets no
 *   override, so it follows the defaults from now on.
 * - A legacy command missing from the table was removed by the user, and gets
 *   a `-X` row so it stays removed.
 * - A legacy command with any other rows keeps them as its replacement.
 * - Rows for any other command are kept as they are.
 *
 * An empty table maps to no overrides: the renderer already showed the
 * defaults for one, so nothing the user sees changes.
 */
export const migrateLegacyKeybindingTable = (
  table: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  if (table.length === 0) {
    return [];
  }
  const stored = byCommand(table.map(clean));
  const followsDefault = new Set<string>();
  const removed: Array<Keybinding> = [];
  for (const [command, rows] of byCommand(LEGACY_DEFAULT_KEYBINDINGS)) {
    const current = stored.get(command);
    if (current === undefined) {
      removed.push(unbindRow(command, rows[0]!.shortcut));
    } else if (sameRows(current, rows)) {
      followsDefault.add(command);
    }
  }
  // Kept in table order: resolution is first-match, so the rows that survive
  // keep the precedence they had between themselves.
  return [...table.map(clean).filter((row) => !followsDefault.has(row.command)), ...removed];
};
