import { describe, expect, it } from "vitest";

import type { Keybinding } from "@OpenAde/contracts/settings";

import {
  evaluateWhen,
  findKeybindingConflicts,
  formatEventAsShortcut,
  matchShortcut,
  parseShortcut,
  resolveKeybinding,
  type ShortcutEvent,
} from "./keybindings";

const press = (key: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("parseShortcut", () => {
  it("parses modifiers and normalises the key", () => {
    expect(parseShortcut("Cmd+Shift+B")).toEqual({
      key: "b",
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
    });
    expect(parseShortcut("Escape")).toEqual({
      key: "escape",
      mod: false,
      ctrl: false,
      alt: false,
      shift: false,
    });
    expect(parseShortcut("Cmd+Enter")).toMatchObject({ key: "enter", mod: true });
    expect(parseShortcut("cmd + , ")).toMatchObject({ key: ",", mod: true });
  });

  it("rejects chords without a key or with two keys", () => {
    expect(parseShortcut("Cmd")).toBeNull();
    expect(parseShortcut("Cmd+")).toBeNull();
    expect(parseShortcut("a+b")).toBeNull();
    expect(parseShortcut("")).toBeNull();
  });
});

describe("matchShortcut", () => {
  const mac = "meta" as const;
  const win = "ctrl" as const;

  it("maps Cmd to metaKey on mac and ctrlKey elsewhere", () => {
    const binding = parseShortcut("Cmd+K")!;
    expect(matchShortcut(binding, press("k", { metaKey: true }), mac)).toBe(true);
    expect(matchShortcut(binding, press("k", { ctrlKey: true }), mac)).toBe(false);
    expect(matchShortcut(binding, press("k", { ctrlKey: true }), win)).toBe(true);
    expect(matchShortcut(binding, press("k", { metaKey: true }), win)).toBe(false);
  });

  it("requires the exact modifier set", () => {
    const escape = parseShortcut("Escape")!;
    expect(matchShortcut(escape, press("Escape"), mac)).toBe(true);
    expect(matchShortcut(escape, press("Escape", { shiftKey: true }), mac)).toBe(false);
    const cmdK = parseShortcut("Cmd+K")!;
    expect(matchShortcut(cmdK, press("k", { metaKey: true, altKey: true }), mac)).toBe(false);
  });

  it("keeps Ctrl physical on mac", () => {
    const ctrlX = parseShortcut("Ctrl+X")!;
    expect(matchShortcut(ctrlX, press("x", { ctrlKey: true }), mac)).toBe(true);
    expect(matchShortcut(ctrlX, press("x", { metaKey: true }), mac)).toBe(false);
  });

  it("matches letters regardless of case from Shift", () => {
    const binding = parseShortcut("Cmd+Shift+B")!;
    expect(
      matchShortcut(binding, press("B", { metaKey: true, shiftKey: true }), mac),
    ).toBe(true);
  });
});

describe("formatEventAsShortcut", () => {
  it("renders the stored notation", () => {
    expect(formatEventAsShortcut(press("b", { metaKey: true, shiftKey: true }), "meta")).toBe(
      "Cmd+Shift+B",
    );
    expect(formatEventAsShortcut(press("x", { ctrlKey: true }), "meta")).toBe("Ctrl+X");
    expect(formatEventAsShortcut(press("k", { ctrlKey: true }), "ctrl")).toBe("Cmd+K");
    expect(formatEventAsShortcut(press("Escape"), "meta")).toBe("Escape");
  });

  it("ignores modifier-only presses", () => {
    expect(formatEventAsShortcut(press("Meta", { metaKey: true }), "meta")).toBeNull();
    expect(formatEventAsShortcut(press("Shift", { shiftKey: true }), "meta")).toBeNull();
  });
});

describe("evaluateWhen", () => {
  const ctx = (flags: Record<string, boolean | string>) => (name: string) => flags[name];

  it("evaluates flags, negation, and/or and parens", () => {
    expect(evaluateWhen("composerFocus", ctx({ composerFocus: true }))).toBe(true);
    expect(evaluateWhen("!composerFocus", ctx({ composerFocus: true }))).toBe(false);
    expect(evaluateWhen("a && b", ctx({ a: true, b: true }))).toBe(true);
    expect(evaluateWhen("a && b", ctx({ a: true, b: false }))).toBe(false);
    expect(evaluateWhen("a || b", ctx({ a: false, b: true }))).toBe(true);
    expect(evaluateWhen("a && (b || c)", ctx({ a: true, b: false, c: true }))).toBe(true);
  });

  it("compares string values with == and !=", () => {
    const flags = { mode: "plan" };
    expect(evaluateWhen('mode == "plan"', ctx(flags))).toBe(true);
    expect(evaluateWhen('mode != "plan"', ctx(flags))).toBe(false);
    expect(evaluateWhen('mode == "default"', ctx(flags))).toBe(false);
    expect(evaluateWhen('missing == "x"', ctx({}))).toBe(false);
    expect(evaluateWhen('missing != "x"', ctx({}))).toBe(true);
  });

  it("treats unknown flags and unparseable input as false", () => {
    expect(evaluateWhen("nope", ctx({}))).toBe(false);
    expect(evaluateWhen("a &&", ctx({ a: true }))).toBe(false);
    expect(evaluateWhen("(a", ctx({ a: true }))).toBe(false);
    expect(evaluateWhen("a b", ctx({ a: true, b: true }))).toBe(false);
  });

  it("treats an empty clause as always true", () => {
    expect(evaluateWhen("", ctx({}))).toBe(true);
    expect(evaluateWhen("   ", ctx({}))).toBe(true);
  });
});

describe("resolveKeybinding", () => {
  // First match wins, so scoped bindings sit ahead of the defaults.
  const bindings: ReadonlyArray<Keybinding> = [
    { command: "custom.escape", shortcut: "Escape", when: "menuOpen" },
    { command: "thread.interrupt", shortcut: "Escape" },
    { command: "commandPalette.toggle", shortcut: "Cmd+K" },
    { command: "composer.queue", shortcut: "Cmd+Enter" },
  ];

  it("returns the matching command", () => {
    expect(
      resolveKeybinding(bindings, press("k", { metaKey: true }), () => false, "meta")?.command,
    ).toBe("commandPalette.toggle");
    expect(
      resolveKeybinding(bindings, press("Escape"), () => false, "meta")?.command,
    ).toBe("thread.interrupt");
  });

  it("honours when clauses and returns null on no match", () => {
    expect(
      resolveKeybinding(bindings, press("Escape"), (n) => n === "menuOpen", "meta")?.command,
    ).toBe("custom.escape");
    expect(resolveKeybinding(bindings, press("x"), () => false, "meta")).toBeNull();
  });
});

describe("findKeybindingConflicts", () => {
  it("groups bindings on the same chord in the same scope", () => {
    const conflicts = findKeybindingConflicts([
      { command: "a", shortcut: "Cmd+K" },
      { command: "b", shortcut: "cmd+k" },
      { command: "c", shortcut: "Cmd+K", when: "menuOpen" },
      { command: "d", shortcut: "Escape" },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.map((b) => b.command)).toEqual(["a", "b"]);
  });
});
