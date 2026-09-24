/**
 * Locks the shipped keymap. Every rule here is about the table as a whole, so
 * a shortcut added later — for the terminal, git, the browser pane, anything —
 * cannot silently take a chord another command, a reserved feature or the
 * operating system already holds.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  LEGACY_DEFAULT_KEYBINDINGS,
  RESERVED_KEYBINDINGS,
  migrateLegacyKeybindingTable,
  resolveKeymap,
} from "@OpenAde/contracts/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";

import {
  parseShortcut,
  parseWhen,
  resolveKeybinding,
  whenNeedsTextFocus,
  type ModKey,
} from "./keybindings";
import { findKeybindingConflicts, reservedChordReason, whenOverlaps } from "./keymap";

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

/**
 * Plain or Shift-only printable keys whose clause neither needs a text field
 * nor rules one out. A printable key either acts in a named field or says
 * `!inputFocus`, so where it fires is written in the clause rather than left
 * to the text-field rule.
 */
const unscopedPlainKeys = (table: ReadonlyArray<Keybinding>): ReadonlyArray<Keybinding> =>
  table.filter((row) => {
    const parsed = parseShortcut(row.shortcut);
    return (
      parsed !== null &&
      !parsed.mod &&
      !parsed.ctrl &&
      !parsed.alt &&
      [...parsed.key].length === 1 &&
      !whenNeedsTextFocus(row.when) &&
      PLATFORMS.some((platform) => whenOverlaps(row.when, "inputFocus", platform))
    );
  });

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
      const reason = reservedChordReason(row.shortcut, platform, row.when);
      return reason === null ? [] : [`${describeRow(row)}: ${reason}`];
    });
    expect(taken).toEqual([]);
  });

  it("binds Tab, Enter, Space and plain arrows only where a clause needs a text field", () => {
    const loose = DEFAULT_KEYBINDINGS.filter((row) => {
      const parsed = parseShortcut(row.shortcut);
      return (
        parsed !== null &&
        !parsed.mod &&
        !parsed.ctrl &&
        !parsed.alt &&
        TEXT_KEYS.has(parsed.key) &&
        !whenNeedsTextFocus(row.when)
      );
    });
    expect(loose.map(describeRow)).toEqual([]);
  });

  it("scopes every plain or Shift-only key to a text field or to outside one", () => {
    expect(unscopedPlainKeys(DEFAULT_KEYBINDINGS).map(describeRow)).toEqual([]);
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
  it("catch a plain key scoped only by a negated focus key", () => {
    const rows: ReadonlyArray<Keybinding> = [
      { command: "extra.thing", shortcut: "I", when: "!browserFocus" },
      { command: "extra.other", shortcut: "Shift+J", when: "threadOpen && !terminalFocus" },
      { command: "extra.fine", shortcut: "J", when: "threadOpen && !inputFocus" },
      { command: "extra.typed", shortcut: "J", when: "composerFocus" },
    ];
    expect(unscopedPlainKeys(rows).map((row) => row.command)).toEqual([
      "extra.thing",
      "extra.other",
    ]);
  });

  it("catch a duplicate chord in an overlapping context", () => {
    const table = [...DEFAULT_KEYBINDINGS, { command: "extra.thing", shortcut: "Mod+Shift+L" }];
    expect(describeConflicts(table, "meta")).toHaveLength(1);
    expect(describeConflicts(table, "ctrl")).toHaveLength(1);
  });

  it("catch a duplicate spelled with the shifted character", () => {
    // `Mod+Shift+}` fires on the same press as thread.next's `Mod+Shift+]`.
    const table = [...DEFAULT_KEYBINDINGS, { command: "extra.thing", shortcut: "Mod+Shift+}" }];
    expect(describeConflicts(table, "meta")).toEqual([
      "thread.next Mod+Shift+] ↔ extra.thing Mod+Shift+}",
    ]);
    expect(describeConflicts(table, "ctrl")).toHaveLength(1);
  });

  it("catch a default that takes a reserved chord", () => {
    const table = [
      ...DEFAULT_KEYBINDINGS,
      { command: "extra.thing", shortcut: "Mod+Shift+Enter" },
      ...RESERVED_KEYBINDINGS,
    ];
    expect(describeConflicts(table, "meta")).toEqual([
      "extra.thing Mod+Shift+Enter ↔ composer.steer Mod+Shift+Enter",
    ]);
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
    // `Mod+[` steps the app's history everywhere but the browser pane, and
    // the pane's own history inside it.
    const scoped = DEFAULT_KEYBINDINGS.filter((row) => row.shortcut === "Mod+[");
    expect(scoped.map((row) => row.command).sort()).toEqual(["browser.back", "nav.back"]);
    expect(describeConflicts(scoped, "meta")).toEqual([]);
  });
});

describe("Escape in the shipped table", () => {
  const escape = {
    key: "Escape",
    code: "Escape",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  const resolve = (...flags: ReadonlyArray<string>) =>
    resolveKeybinding(DEFAULT_KEYBINDINGS, escape, (name) => flags.includes(name), "meta")
      ?.command ?? null;

  it("stops the turn from the composer, even with an approval up", () => {
    expect(resolve("turnRunning", "inputFocus", "composerFocus")).toBe("thread.interrupt");
    expect(resolve("turnRunning", "inputFocus", "composerFocus", "approvalPending")).toBe(
      "thread.interrupt",
    );
  });

  it("stops the turn from the page, and denies an approval there instead", () => {
    expect(resolve("turnRunning")).toBe("thread.interrupt");
    expect(resolve("turnRunning", "approvalPending")).toBe("approval.deny");
  });

  it("leaves any other text field its own Escape", () => {
    expect(resolve("turnRunning", "inputFocus")).toBeNull();
    expect(resolve("turnRunning", "inputFocus", "browserFocus")).toBeNull();
    expect(resolve("turnRunning", "inputFocus", "terminalFocus")).toBeNull();
    expect(resolve("turnRunning", "inputFocus", "approvalPending")).toBeNull();
  });

  it("still denies an approval after a legacy interrupt override migrates", () => {
    const legacy = [
      ...LEGACY_DEFAULT_KEYBINDINGS,
      { command: "thread.interrupt", shortcut: "Cmd+." },
    ];
    const table = resolveKeymap(DEFAULT_KEYBINDINGS, migrateLegacyKeybindingTable(legacy));
    const context = (name: string) => name === "turnRunning" || name === "approvalPending";
    expect(resolveKeybinding(table, escape, context, "meta")?.command).toBe("approval.deny");
  });

  it("does nothing with a dialog open or no turn running", () => {
    expect(resolve("turnRunning", "dialogOpen")).toBeNull();
    expect(resolve("inputFocus", "composerFocus")).toBeNull();
  });
});
