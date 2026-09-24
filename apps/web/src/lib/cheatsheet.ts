/**
 * The keyboard shortcuts sheet as data: every catalog command grouped by area,
 * each with the chords the live table binds to it — user overrides applied —
 * and the `when` clauses those chords are scoped to, plus the fixed composer
 * keys. Pure, so the grouping and the search are tested without a DOM; the
 * dialog that draws it is `@/components/keybindings/shortcuts-dialog`.
 */

import { parseShortcut, type ModKey } from "@poseidon/client-runtime/keybindings";
import { physicalChord, type PhysicalChord } from "@poseidon/client-runtime/keymap";
import type { Keybinding } from "@poseidon/contracts/settings";

import {
  COMMAND_AREAS,
  FIXED_KEYS,
  type CatalogCommand,
  type CommandArea,
  type FixedKey,
} from "@/lib/command-catalog";
import { keycapsFor } from "@/lib/keybindings";

export interface CheatsheetChord {
  /** The stored notation, e.g. `Mod+Shift+B`. */
  readonly shortcut: string;
  /** The keycaps drawn for this platform, e.g. `["⌘", "⇧", "B"]`. */
  readonly caps: ReadonlyArray<string>;
}

export interface CheatsheetRow {
  /** The command id, or `fixed:N` for a fixed composer key. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Every chord bound to it, in table order. Empty when it is unbound. */
  readonly chords: ReadonlyArray<CheatsheetChord>;
  /** The distinct `when` clauses of those chords; empty when they hold everywhere. */
  readonly when: ReadonlyArray<string>;
  /** A key the composer handles itself; it cannot be rebound. */
  readonly fixed: boolean;
}

export interface CheatsheetSection {
  readonly area: CommandArea;
  readonly rows: ReadonlyArray<CheatsheetRow>;
}

const chordOf = (shortcut: string, modKey: ModKey): CheatsheetChord => ({
  shortcut,
  caps: keycapsFor(shortcut, modKey),
});

const commandRow = (
  entry: CatalogCommand,
  effective: ReadonlyArray<Keybinding>,
  modKey: ModKey,
): CheatsheetRow => {
  const rows = effective.filter((binding) => binding.command === entry.id);
  return {
    id: entry.id,
    title: entry.title,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    chords: rows.map((binding) => chordOf(binding.shortcut, modKey)),
    when: [
      ...new Set(rows.flatMap((binding) => (binding.when === undefined ? [] : [binding.when]))),
    ],
    fixed: false,
  };
};

const fixedRow = (key: FixedKey, index: number, modKey: ModKey): CheatsheetRow => ({
  id: `fixed:${index}`,
  title: key.title,
  chords: key.keys.map((shortcut) => chordOf(shortcut, modKey)),
  when: [],
  fixed: true,
});

/**
 * `word` read as a whole chord (`cmd+shift+b`, `ctrl+k`) in keymap notation,
 * so every alias the matcher accepts works here too. Null when it is not one.
 */
const wordAsChord = (word: string, modKey: ModKey): PhysicalChord | null => {
  const parsed = parseShortcut(word);
  return parsed === null ? null : physicalChord(parsed, modKey);
};

/** `word` read as one modifier name (`shift`, `Cmd`, `option`), or null. */
const wordAsModifier = (word: string, modKey: ModKey): PhysicalChord | null => {
  const parsed = parseShortcut(`${word}+a`);
  return parsed === null ||
    parsed.key !== "a" ||
    !(parsed.mod || parsed.ctrl || parsed.alt || parsed.shift)
    ? null
    : physicalChord(parsed, modKey);
};

const sameChord = (a: PhysicalChord, b: PhysicalChord): boolean =>
  a.key === b.key &&
  a.ctrl === b.ctrl &&
  a.meta === b.meta &&
  a.alt === b.alt &&
  a.shift === b.shift;

const holdsModifiers = (chord: PhysicalChord, modifiers: PhysicalChord): boolean =>
  (!modifiers.ctrl || chord.ctrl) &&
  (!modifiers.meta || chord.meta) &&
  (!modifiers.alt || chord.alt) &&
  (!modifiers.shift || chord.shift);

/**
 * Whether one search word matches a row: it occurs in the title, id,
 * description or a `when` clause; or it is one of the row's chords — as drawn
 * (`⌘k`, `⌘+⇧+b`), one keycap of one (`esc`, `b`), or read as a chord in keymap
 * notation (`mod+k`, `cmd+shift+b`, `ctrl+k`) and compared as the keys held on
 * this platform; or it names a modifier one of the chords holds (`shift`,
 * `Cmd`). Chords match whole, so `cmd+shift+b` does not find
 * `Mod+Shift+Backspace`.
 */
const wordMatches = (
  word: string,
  row: CheatsheetRow,
  chords: ReadonlyArray<PhysicalChord>,
  modKey: ModKey,
): boolean => {
  const text = [row.title, row.id, row.description ?? "", ...row.when].join(" ").toLowerCase();
  if (text.includes(word)) {
    return true;
  }
  const drawn = row.chords.flatMap((chord) => {
    const caps = chord.caps.map((cap) => cap.toLowerCase());
    return [caps.join("+"), caps.join(""), ...caps];
  });
  if (drawn.includes(word)) {
    return true;
  }
  const asChord = wordAsChord(word, modKey);
  if (asChord !== null && chords.some((chord) => sameChord(chord, asChord))) {
    return true;
  }
  const asModifier = wordAsModifier(word, modKey);
  return asModifier !== null && chords.some((chord) => holdsModifiers(chord, asModifier));
};

/** True when every word of the query matches the row (`wordMatches`). */
const matches = (row: CheatsheetRow, words: ReadonlyArray<string>, modKey: ModKey): boolean => {
  const chords = row.chords.flatMap((chord) => {
    const parsed = parseShortcut(chord.shortcut);
    return parsed === null ? [] : [physicalChord(parsed, modKey)];
  });
  return words.every((word) => wordMatches(word, row, chords, modKey));
};

/**
 * The sheet: one section per area in `COMMAND_AREAS` order, each listing its
 * catalog commands in catalog order with their effective chords, the fixed
 * composer keys after the Composer commands, narrowed to the rows `query`
 * matches. A section with no rows left is dropped.
 */
export const cheatsheetSections = (
  catalog: ReadonlyArray<CatalogCommand>,
  effective: ReadonlyArray<Keybinding>,
  query: string,
  modKey: ModKey,
  fixed: ReadonlyArray<FixedKey> = FIXED_KEYS,
): ReadonlyArray<CheatsheetSection> => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const fixedRows = fixed.map((key, index) => ({ key, row: fixedRow(key, index, modKey) }));
  return COMMAND_AREAS.flatMap((area) => {
    const rows = [
      ...catalog
        .filter((entry) => entry.area === area)
        .map((entry) => commandRow(entry, effective, modKey)),
      ...fixedRows.filter((entry) => entry.key.area === area).map((entry) => entry.row),
    ].filter((row) => matches(row, words, modKey));
    return rows.length === 0 ? [] : [{ area, rows }];
  });
};
