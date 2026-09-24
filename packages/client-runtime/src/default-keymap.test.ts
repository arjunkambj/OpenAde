/**
 * Locks the shipped keymap. Every rule here is about the table as a whole, so
 * a shortcut added later — for the terminal, git, the browser pane, anything —
 * cannot silently take a chord another command, a reserved feature or the
 * operating system already holds.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS, RESERVED_KEYBINDINGS } from "@OpenAde/contracts/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";

import { parseShortcut, parseWhen, whenNamesFocus, type ModKey } from "./keybindings";
import { findKeybindingConflicts, reservedChordReason } from "./keymap";

const PLATFORMS: ReadonlyArray<ModKey> = ["meta", "ctrl"];

const describeRow = (row: Keybinding): string =>
  `${row.command} ${row.shortcut}${row.when === undefined ? "" : ` [${row.when}]`}`;

const describeConflicts = (table: ReadonlyArray<Keybinding>, platform: ModKey): string[] =>
  findKeybindingConflicts(table, platform).map(
    (conflict) => `${describeRow(conflict.first)} ↔ ${describeRow(conflict.second)}`,
  );

/** Keys that move focus, submit, type a space or move the caret. */
const TEXT_KEYS = new Set(["tab", "enter", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

/** The composer's trigger characters, and the US digits Shift turns into them. */
const TRIGGER_CHARACTERS = new Set(["@", "#", "$", "/"]);
const SHIFTED_TRIGGERS = new Set(["2", "3", "4"]);

describe("the default keymap", () => {
  it("parses every shortcut and every when clause", () => {
    for (const row of [...DEFAULT_KEYBINDINGS, ...RESERVED_KEYBINDINGS]) {
      expect(parseShortcut(row.shortcut), describeRow(row)).not.toBeNull();
      expect(parseWhen(row.when ?? ""), describeRow(row)).not.toBeNull();
    }
  });

  it.each(PLATFORMS)("has no two bindings on one chord in overlapping contexts (%s)", (p) => {
    expect(describeConflicts(DEFAULT_KEYBINDINGS, p)).toEqual([]);
  });

  it.each(PLATFORMS)("leaves every reserved chord free (%s)", (platform) => {
    expect(describeConflicts([...DEFAULT_KEYBINDINGS, ...RESERVED_KEYBINDINGS], platform)).toEqual(
      [],
    );
  });

  it.each(PLATFORMS)("takes no chord the system or the shell owns (%s)", (platform) => {
    const taken = DEFAULT_KEYBINDINGS.flatMap((row) => {
      const reason = reservedChordReason(row.shortcut, platform);
      return reason === null ? [] : [`${describeRow(row)}: ${reason}`];
    });
    expect(taken).toEqual([]);
  });

  it("binds Tab, Enter, Space and plain arrows only where a clause names the focus", () => {
    const loose = DEFAULT_KEYBINDINGS.filter((row) => {
      const parsed = parseShortcut(row.shortcut);
      return (
        parsed !== null &&
        !parsed.mod &&
        !parsed.ctrl &&
        !parsed.alt &&
        TEXT_KEYS.has(parsed.key) &&
        !whenNamesFocus(row.when)
      );
    });
    expect(loose.map(describeRow)).toEqual([]);
  });

  it("leaves the composer's trigger characters to be typed", () => {
    const onTriggers = [...DEFAULT_KEYBINDINGS, ...RESERVED_KEYBINDINGS].filter((row) => {
      const parsed = parseShortcut(row.shortcut);
      return (
        parsed !== null &&
        !parsed.mod &&
        !parsed.ctrl &&
        !parsed.alt &&
        (TRIGGER_CHARACTERS.has(parsed.key) || (parsed.shift && SHIFTED_TRIGGERS.has(parsed.key)))
      );
    });
    expect(onTriggers.map(describeRow)).toEqual([]);
  });

  it("names each reserved command once, and none the defaults already bind", () => {
    const reserved = RESERVED_KEYBINDINGS.map((row) => row.command);
    const shipped = new Set(DEFAULT_KEYBINDINGS.map((row) => row.command));
    expect(new Set(reserved).size).toBe(reserved.length);
    expect(reserved.filter((command) => shipped.has(command))).toEqual([]);
    for (const row of RESERVED_KEYBINDINGS) {
      expect(row.for.length, row.command).toBeGreaterThan(0);
    }
  });
});

describe("the collision checks themselves", () => {
  it("catch a duplicate chord in an overlapping context", () => {
    const table = [...DEFAULT_KEYBINDINGS, { command: "extra.thing", shortcut: "Mod+Shift+L" }];
    expect(describeConflicts(table, "meta")).toHaveLength(1);
    expect(describeConflicts(table, "ctrl")).toHaveLength(1);
  });

  it("catch a default that takes a reserved chord", () => {
    const table = [
      ...DEFAULT_KEYBINDINGS,
      { command: "extra.thing", shortcut: "Mod+J" },
      ...RESERVED_KEYBINDINGS,
    ];
    expect(describeConflicts(table, "meta")).toEqual(["extra.thing Mod+J ↔ terminal.toggle Mod+J"]);
  });

  it("count a terminal chord as live wherever an unscoped chord is", () => {
    // composer.focus is `!browserFocus`, which terminal focus satisfies.
    const table = [
      ...DEFAULT_KEYBINDINGS,
      { command: "terminal.clear", shortcut: "Mod+L", when: "terminalFocus" },
    ];
    expect(describeConflicts(table, "meta")).toHaveLength(1);
  });

  it("let two commands share a chord where their contexts cannot overlap", () => {
    const table = [
      ...DEFAULT_KEYBINDINGS,
      { command: "browser.stop", shortcut: "Mod+Shift+.", when: "browserFocus" },
    ];
    expect(describeConflicts(table, "meta")).toHaveLength(1);
    const scoped = [
      ...DEFAULT_KEYBINDINGS,
      { command: "browser.stop", shortcut: "Mod+[", when: "browserFocus" },
    ];
    expect(describeConflicts(scoped, "meta")).toEqual([]);
  });
});
