import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_KEYBINDINGS,
  LEGACY_DEFAULT_KEYBINDINGS,
  diffKeymap,
  isUnbindRow,
  migrateLegacyKeybindingTable,
  resolveKeymap,
} from "./keybindings";
import { Keybinding } from "./settings";

type Row = Keybinding;

/** A small baseline of its own, so these cases do not move as the shipped defaults grow. */
const DEFAULTS: ReadonlyArray<Row> = [
  { command: "a.one", shortcut: "Cmd+A" },
  { command: "b.two", shortcut: "Cmd+B" },
  { command: "b.two", shortcut: "Cmd+Shift+B" },
  { command: "c.three", shortcut: "Escape", when: "threadOpen" },
];

/** A table as `command → sorted rows`, so equality ignores cross-command order. */
const perCommand = (table: ReadonlyArray<Row>) =>
  Object.fromEntries(
    [...new Set(table.map((row) => row.command))].sort().map((command) => [
      command,
      table
        .filter((row) => row.command === command)
        .map((row) => `${row.shortcut}|${row.when ?? ""}`)
        .sort(),
    ]),
  );

describe("DEFAULT_KEYBINDINGS", () => {
  it.effect("binds every shortcut the shell promises", () =>
    Effect.gen(function* () {
      const bindings = yield* Effect.succeed(DEFAULT_KEYBINDINGS);
      const byCommand = new Map(bindings.map((binding) => [binding.command, binding.shortcut]));
      expect(byCommand.get("thread.new")).toBe("Mod+N");
      expect(byCommand.get("commandPalette.toggle")).toBe("Mod+K");
      expect(byCommand.get("composer.queue")).toBe("Mod+Enter");
      expect(byCommand.get("thread.interrupt")).toBe("Escape");
      expect(byCommand.get("browserPane.toggle")).toBe("Mod+Shift+B");
      expect(byCommand.get("sidebar.toggle")).toBe("Mod+B");
      expect(byCommand.get("skills.open")).toBe("Mod+Shift+S");
      expect(byCommand.get("settings.open")).toBe("Mod+,");
    }),
  );

  it.effect("decodes as Keybindings, and unbinds nothing", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Schema.Array(Keybinding));
      const decoded = yield* Effect.sync(() => decode(DEFAULT_KEYBINDINGS));
      expect(decoded).toEqual(DEFAULT_KEYBINDINGS);
      expect(DEFAULT_KEYBINDINGS.some(isUnbindRow)).toBe(false);
    }),
  );
});

describe("isUnbindRow", () => {
  it("recognises a -X row, and nothing else", () => {
    expect(isUnbindRow({ command: "-sidebar.toggle", shortcut: "Cmd+B" })).toBe(true);
    expect(isUnbindRow({ command: "sidebar.toggle", shortcut: "Cmd+B" })).toBe(false);
    expect(isUnbindRow({ command: "-", shortcut: "Cmd+B" })).toBe(false);
  });
});

describe("resolveKeymap", () => {
  it("is the defaults when nothing is overridden", () => {
    expect(resolveKeymap(DEFAULTS, [])).toEqual(DEFAULTS);
  });

  it("replaces every default row of a command the overrides mention", () => {
    const table = resolveKeymap(DEFAULTS, [{ command: "b.two", shortcut: "Cmd+J" }]);
    expect(table.filter((row) => row.command === "b.two")).toEqual([
      { command: "b.two", shortcut: "Cmd+J" },
    ]);
    expect(table.filter((row) => row.command !== "b.two")).toEqual(
      DEFAULTS.filter((row) => row.command !== "b.two"),
    );
  });

  it("unbinds a command named only by a -X row", () => {
    const table = resolveKeymap(DEFAULTS, [{ command: "-c.three", shortcut: "Escape" }]);
    expect(table.some((row) => row.command === "c.three")).toBe(false);
    expect(table.some(isUnbindRow)).toBe(false);
  });

  it("lets a command's own rows win over its -X row", () => {
    const table = resolveKeymap(DEFAULTS, [
      { command: "-a.one", shortcut: "Cmd+A" },
      { command: "a.one", shortcut: "Cmd+Y" },
    ]);
    expect(table.filter((row) => row.command === "a.one")).toEqual([
      { command: "a.one", shortcut: "Cmd+Y" },
    ]);
  });

  it("keeps a command the defaults do not know", () => {
    const table = resolveKeymap(DEFAULTS, [{ command: "later.command", shortcut: "Cmd+L" }]);
    expect(table).toContainEqual({ command: "later.command", shortcut: "Cmd+L" });
    expect(table).toHaveLength(DEFAULTS.length + 1);
  });

  it("puts overrides before the defaults, so an override shadows another default's chord", () => {
    const table = resolveKeymap(DEFAULTS, [{ command: "c.three", shortcut: "Cmd+A" }]);
    expect(table[0]).toEqual({ command: "c.three", shortcut: "Cmd+A" });
    expect(table.slice(1)).toEqual(DEFAULTS.filter((row) => row.command !== "c.three"));
  });

  it("drops an explicit when: undefined from override rows", () => {
    const table = resolveKeymap(DEFAULTS, [
      { command: "a.one", shortcut: "Cmd+Y", when: undefined },
    ]);
    expect(Object.keys(table[0]!)).toEqual(["command", "shortcut"]);
  });
});

describe("diffKeymap", () => {
  it("emits nothing for the defaults themselves", () => {
    expect(diffKeymap(DEFAULTS, DEFAULTS)).toEqual([]);
  });

  it("emits every row of a command whose rows changed", () => {
    const effective = DEFAULTS.map((row) =>
      row.shortcut === "Cmd+Shift+B" ? { ...row, shortcut: "Cmd+Alt+B" } : row,
    );
    expect(diffKeymap(DEFAULTS, effective)).toEqual([
      { command: "b.two", shortcut: "Cmd+B" },
      { command: "b.two", shortcut: "Cmd+Alt+B" },
    ]);
  });

  it("emits one -X row for a default command left with no rows", () => {
    const effective = DEFAULTS.filter((row) => row.command !== "b.two");
    expect(diffKeymap(DEFAULTS, effective)).toEqual([{ command: "-b.two", shortcut: "Cmd+B" }]);
  });

  it("emits a command the defaults do not know, and a changed when", () => {
    const effective = [
      ...DEFAULTS.filter((row) => row.command !== "c.three"),
      { command: "c.three", shortcut: "Escape" },
      { command: "extra.one", shortcut: "Cmd+E", when: "composerFocus" },
    ];
    expect(diffKeymap(DEFAULTS, effective)).toEqual([
      { command: "c.three", shortcut: "Escape" },
      { command: "extra.one", shortcut: "Cmd+E", when: "composerFocus" },
    ]);
  });

  it("round-trips through resolveKeymap", () => {
    const cases: ReadonlyArray<ReadonlyArray<Row>> = [
      DEFAULTS,
      [],
      [{ command: "a.one", shortcut: "Cmd+Z" }],
      [
        { command: "c.three", shortcut: "Cmd+A", when: "composerFocus" },
        { command: "b.two", shortcut: "Cmd+B" },
        { command: "new.one", shortcut: "Cmd+N" },
        { command: "new.one", shortcut: "Cmd+M" },
      ],
    ];
    for (const effective of cases) {
      expect(perCommand(resolveKeymap(DEFAULTS, diffKeymap(DEFAULTS, effective)))).toEqual(
        perCommand(effective),
      );
    }
  });
});

describe("migrateLegacyKeybindingTable", () => {
  const legacy = LEGACY_DEFAULT_KEYBINDINGS;

  it("keeps the legacy defaults verbatim, Cmd strings included", () => {
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(legacy).toHaveLength(8);
    expect(legacy.map((row) => row.shortcut)).toContain("Cmd+Shift+S");
  });

  it("maps an untouched legacy table to no overrides", () => {
    expect(migrateLegacyKeybindingTable(legacy)).toEqual([]);
  });

  it("maps an empty table to no overrides", () => {
    expect(migrateLegacyKeybindingTable([])).toEqual([]);
  });

  it("keeps a rebound legacy command as its replacement", () => {
    const table = legacy.map((row) =>
      row.command === "thread.new" ? { ...row, shortcut: "Cmd+Shift+T" } : row,
    );
    expect(migrateLegacyKeybindingTable(table)).toEqual([
      { command: "thread.new", shortcut: "Cmd+Shift+T" },
    ]);
  });

  it("treats a changed when clause as a rebinding", () => {
    const table = legacy.map((row) =>
      row.command === "browserPane.toggle" ? { ...row, when: "threadOpen" } : row,
    );
    expect(migrateLegacyKeybindingTable(table)).toEqual([
      { command: "browserPane.toggle", shortcut: "Cmd+Shift+B", when: "threadOpen" },
    ]);
  });

  it("unbinds a legacy command the user removed", () => {
    const table = legacy.filter((row) => row.command !== "sidebar.toggle");
    expect(migrateLegacyKeybindingTable(table)).toEqual([
      { command: "-sidebar.toggle", shortcut: "Cmd+B" },
    ]);
  });

  it("keeps a second row added to a legacy command, with the first", () => {
    const table = [...legacy, { command: "settings.open", shortcut: "Cmd+;" }];
    expect(migrateLegacyKeybindingTable(table)).toEqual([
      { command: "settings.open", shortcut: "Cmd+," },
      { command: "settings.open", shortcut: "Cmd+;" },
    ]);
  });

  it("keeps rows for commands the legacy table never had", () => {
    const table = [...legacy, { command: "custom.thing", shortcut: "Cmd+Y" }];
    expect(migrateLegacyKeybindingTable(table)).toEqual([
      { command: "custom.thing", shortcut: "Cmd+Y" },
    ]);
  });

  it("resolves every legacy chord exactly as before, and new defaults on top", () => {
    const newer = [...legacy, { command: "later.command", shortcut: "Cmd+Shift+L" }];
    const resolved = resolveKeymap(newer, migrateLegacyKeybindingTable(legacy));
    expect(resolved).toEqual(newer);
  });

  it("is deterministic, so a restart before any write changes nothing", () => {
    const table = [
      ...legacy.filter((row) => row.command !== "skills.open"),
      { command: "custom.thing", shortcut: "Cmd+Y" },
    ];
    expect(migrateLegacyKeybindingTable(table)).toEqual(migrateLegacyKeybindingTable(table));
  });
});
