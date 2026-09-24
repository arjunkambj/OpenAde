import { describe, expect, it } from "vitest";

import type { Keybinding } from "@OpenAde/contracts/settings";

import {
  evaluateWhen,
  firesInTextField,
  formatEventAsShortcut,
  isAltGraphTyping,
  matchShortcut,
  parseShortcut,
  parseWhen,
  resolveKeybinding,
  whenNeedsTextFocus,
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
    expect(matchShortcut(binding, press("B", { metaKey: true, shiftKey: true }), mac)).toBe(true);
  });
});

describe("formatEventAsShortcut", () => {
  it("renders the stored notation", () => {
    expect(formatEventAsShortcut(press("b", { metaKey: true, shiftKey: true }), "meta")).toBe(
      "Mod+Shift+B",
    );
    expect(formatEventAsShortcut(press("x", { ctrlKey: true }), "meta")).toBe("Ctrl+X");
    expect(formatEventAsShortcut(press("k", { ctrlKey: true }), "ctrl")).toBe("Mod+K");
    expect(formatEventAsShortcut(press("Escape"), "meta")).toBe("Escape");
  });

  it("ignores modifier-only presses", () => {
    expect(formatEventAsShortcut(press("Meta", { metaKey: true }), "meta")).toBeNull();
    expect(formatEventAsShortcut(press("Shift", { shiftKey: true }), "meta")).toBeNull();
  });

  it("refuses a Super/Win press off macOS rather than write it as Ctrl", () => {
    // The regression: Super+K recorded as `Ctrl+K`, which off macOS fires on
    // Ctrl+K and never on the Super+K that recorded it.
    expect(formatEventAsShortcut(press("k", { code: "KeyK", metaKey: true }), "ctrl")).toBeNull();
    expect(
      formatEventAsShortcut(press("k", { code: "KeyK", metaKey: true, ctrlKey: true }), "ctrl"),
    ).toBeNull();
    expect(
      formatEventAsShortcut(press("K", { code: "KeyK", metaKey: true, shiftKey: true }), "ctrl"),
    ).toBeNull();
    expect(formatEventAsShortcut(press("k", { ctrlKey: true, metaKey: true }), "meta")).toBe(
      "Mod+Ctrl+K",
    );
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
    expect(resolveKeybinding(bindings, press("Escape"), () => false, "meta")?.command).toBe(
      "thread.interrupt",
    );
  });

  it("honours when clauses and returns null on no match", () => {
    expect(
      resolveKeybinding(bindings, press("Escape"), (n) => n === "menuOpen", "meta")?.command,
    ).toBe("custom.escape");
    expect(resolveKeybinding(bindings, press("x"), () => false, "meta")).toBeNull();
  });
});

describe("Mod notation", () => {
  it("parses Mod, Cmd and Meta as the same platform modifier", () => {
    expect(parseShortcut("Mod+Shift+B")).toEqual(parseShortcut("Cmd+Shift+B"));
    expect(parseShortcut("Meta+Shift+B")).toEqual(parseShortcut("Cmd+Shift+B"));
    expect(parseShortcut("Ctrl+B")).toMatchObject({ mod: false, ctrl: true });
  });

  it("resolves Cmd+N and Mod+N identically on both platforms", () => {
    const table = (shortcut: string): ReadonlyArray<Keybinding> => [
      { command: "thread.new", shortcut },
    ];
    for (const [modKey, event] of [
      ["meta", press("n", { metaKey: true })],
      ["ctrl", press("n", { ctrlKey: true })],
    ] as const) {
      for (const shortcut of ["Cmd+N", "Mod+N", "Meta+N"]) {
        expect(resolveKeybinding(table(shortcut), event, () => false, modKey)?.command).toBe(
          "thread.new",
        );
      }
    }
  });
});

describe("layout-safe matching", () => {
  const mac = "meta" as const;

  it("matches Shift chords on the key event.code names", () => {
    const chord = parseShortcut("Mod+Shift+[")!;
    const event = press("{", { code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(matchShortcut(chord, event, mac)).toBe(true);
    const period = parseShortcut("Mod+Shift+.")!;
    expect(
      matchShortcut(period, press(">", { code: "Period", metaKey: true, shiftKey: true }), mac),
    ).toBe(true);
  });

  it("matches macOS Option chords whose key is a symbol or a dead key", () => {
    const chord = parseShortcut("Mod+Alt+R")!;
    expect(
      matchShortcut(chord, press("®", { code: "KeyR", metaKey: true, altKey: true }), mac),
    ).toBe(true);
    const e = parseShortcut("Mod+Alt+E")!;
    expect(
      matchShortcut(e, press("Dead", { code: "KeyE", metaKey: true, altKey: true }), mac),
    ).toBe(true);
  });

  it("does not fall back to event.code without Alt or Shift", () => {
    const chord = parseShortcut("Mod+[")!;
    expect(matchShortcut(chord, press("{", { code: "BracketLeft", metaKey: true }), mac)).toBe(
      false,
    );
    expect(matchShortcut(chord, press("[", { code: "BracketLeft", metaKey: true }), mac)).toBe(
      true,
    );
  });

  it("trusts a reported letter over the physical key", () => {
    // AZERTY: the key at KeyQ types `a`.
    const chord = parseShortcut("Mod+Shift+Q")!;
    expect(
      matchShortcut(chord, press("A", { code: "KeyQ", metaKey: true, shiftKey: true }), mac),
    ).toBe(false);
  });

  it("records the physical key when a modifier changed the character", () => {
    expect(
      formatEventAsShortcut(
        press("{", { code: "BracketLeft", metaKey: true, shiftKey: true }),
        mac,
      ),
    ).toBe("Mod+Shift+[");
    expect(
      formatEventAsShortcut(press("®", { code: "KeyR", metaKey: true, altKey: true }), mac),
    ).toBe("Mod+Alt+R");
    expect(
      formatEventAsShortcut(press("!", { code: "Digit1", ctrlKey: true, shiftKey: true }), "ctrl"),
    ).toBe("Mod+Shift+1");
    expect(formatEventAsShortcut(press("F5", { code: "F5" }), mac)).toBe("F5");
    expect(formatEventAsShortcut(press("+", { code: "NumpadAdd", metaKey: true }), mac)).toBe(
      "Mod+Plus",
    );
    expect(formatEventAsShortcut(press("AltGraph", { code: "AltRight" }), "ctrl")).toBeNull();
  });
});

describe("isAltGraphTyping", () => {
  it("is true when the event reports AltGraph", () => {
    const event = {
      ...press("ć", { code: "KeyC" }),
      getModifierState: (k: string) => k === "AltGraph",
    };
    expect(isAltGraphTyping(event, "ctrl")).toBe(true);
  });

  it("is true off macOS for Ctrl+Alt typing a character that is not the key's own", () => {
    expect(
      isAltGraphTyping(press("ć", { code: "KeyC", ctrlKey: true, altKey: true }), "ctrl"),
    ).toBe(true);
    expect(
      isAltGraphTyping(press("}", { code: "Digit0", ctrlKey: true, altKey: true }), "ctrl"),
    ).toBe(true);
  });

  it("is false for a real Ctrl+Alt chord", () => {
    expect(
      isAltGraphTyping(press("c", { code: "KeyC", ctrlKey: true, altKey: true }), "ctrl"),
    ).toBe(false);
    expect(
      isAltGraphTyping(
        press("{", { code: "BracketLeft", ctrlKey: true, altKey: true, shiftKey: true }),
        "ctrl",
      ),
    ).toBe(false);
    expect(
      isAltGraphTyping(
        press("Backspace", { code: "Backspace", ctrlKey: true, altKey: true }),
        "ctrl",
      ),
    ).toBe(false);
  });

  it("is false on macOS, where Option symbols are matched by code instead", () => {
    expect(
      isAltGraphTyping(press("ç", { code: "KeyC", ctrlKey: true, altKey: true }), "meta"),
    ).toBe(false);
  });

  it("keeps AltGr typing from resolving a Mod+Alt binding", () => {
    const table: ReadonlyArray<Keybinding> = [{ command: "git.commit", shortcut: "Mod+Alt+C" }];
    const altGr = press("ć", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(resolveKeybinding(table, altGr, () => false, "ctrl")).toBeNull();
    const chord = press("c", { code: "KeyC", ctrlKey: true, altKey: true });
    expect(resolveKeybinding(table, chord, () => false, "ctrl")?.command).toBe("git.commit");
  });
});

describe("the text-field rule", () => {
  const typing = (name: string) => name === "inputFocus" || name === "composerFocus";
  const bindings: ReadonlyArray<Keybinding> = [
    { command: "approval.allowOnce", shortcut: "1", when: "approvalPending" },
    { command: "composer.planMode.toggle", shortcut: "Shift+Tab", when: "composerFocus" },
    { command: "thread.interrupt", shortcut: "Escape" },
    { command: "commandPalette.toggle", shortcut: "Mod+K" },
    { command: "help", shortcut: "F1" },
    { command: "plain.alt", shortcut: "Alt+X" },
  ];
  const resolve = (event: ShortcutEvent, context: (name: string) => boolean) =>
    resolveKeybinding(bindings, event, context, "meta")?.command ?? null;

  it("keeps plain keys out of text fields", () => {
    const pending = (name: string) => typing(name) || name === "approvalPending";
    expect(resolve(press("1"), pending)).toBeNull();
    expect(resolve(press("1"), (name) => name === "approvalPending")).toBe("approval.allowOnce");
    expect(resolve(press("x", { altKey: true }), typing)).toBeNull();
    expect(resolve(press("x", { altKey: true }), () => false)).toBe("plain.alt");
  });

  it("lets a clause that needs a text field opt in", () => {
    expect(resolve(press("Tab", { shiftKey: true }), typing)).toBe("composer.planMode.toggle");
  });

  it("keeps a clause that only negates a focus key out of text fields", () => {
    // `!browserFocus` keeps a chord away from the browser pane; it says nothing
    // about text fields, so a plain key under it must not eat typed characters.
    const scoped: ReadonlyArray<Keybinding> = [
      { command: "x", shortcut: "J", when: "!terminalFocus" },
      { command: "y", shortcut: "I", when: "threadOpen && !browserFocus" },
      { command: "z", shortcut: "Backspace", when: "!browserFocus" },
    ];
    const open = (name: string) => typing(name) || name === "threadOpen";
    const run = (event: ShortcutEvent) =>
      resolveKeybinding(scoped, event, open, "meta")?.command ?? null;
    expect(run(press("j"))).toBeNull();
    expect(run(press("i"))).toBeNull();
    expect(run(press("Backspace"))).toBeNull();
    expect(resolveKeybinding(scoped, press("j"), () => false, "meta")?.command).toBe("x");
  });

  it("lets Escape, F-keys and Mod chords through", () => {
    expect(resolve(press("Escape"), typing)).toBe("thread.interrupt");
    expect(resolve(press("F1"), typing)).toBe("help");
    expect(resolve(press("k", { metaKey: true }), typing)).toBe("commandPalette.toggle");
  });

  it("classifies chords", () => {
    const fires = (shortcut: string, when?: string) =>
      firesInTextField(parseShortcut(shortcut)!, when);
    expect(fires("Ctrl+A")).toBe(true);
    expect(fires("F24")).toBe(true);
    expect(fires("F25")).toBe(false);
    expect(fires("Enter")).toBe(false);
    expect(fires("ArrowUp")).toBe(false);
    expect(fires("Tab", "composerFocus")).toBe(true);
    expect(fires("Tab", "!terminalFocus")).toBe(false);
  });

  it("opts in only a clause that cannot hold outside a text field", () => {
    expect(whenNeedsTextFocus("composerFocus")).toBe(true);
    expect(whenNeedsTextFocus("terminalFocus && !dialogOpen")).toBe(true);
    expect(whenNeedsTextFocus("inputFocus && (a || b)")).toBe(true);
    expect(whenNeedsTextFocus("composerFocus || terminalFocus")).toBe(true);
    expect(whenNeedsTextFocus('inputFocus == "true"')).toBe(true);
    expect(whenNeedsTextFocus("!terminalFocus")).toBe(false);
    expect(whenNeedsTextFocus("approvalPending && !browserFocus")).toBe(false);
    expect(whenNeedsTextFocus("composerFocus || approvalPending")).toBe(false);
    expect(whenNeedsTextFocus('mode == "plan"')).toBe(false);
    expect(whenNeedsTextFocus("browserFocus")).toBe(false);
    expect(whenNeedsTextFocus("approvalPending")).toBe(false);
    expect(whenNeedsTextFocus("composerFocus &&")).toBe(false);
    expect(whenNeedsTextFocus(undefined)).toBe(false);
  });
});

describe("parseWhen", () => {
  it("builds a tree, and returns the constant true for an empty clause", () => {
    expect(parseWhen("")).toEqual({ kind: "const", value: true });
    expect(parseWhen("!a && b")).toEqual({
      kind: "and",
      left: { kind: "not", operand: { kind: "flag", name: "a" } },
      right: { kind: "flag", name: "b" },
    });
    expect(parseWhen('mode != "plan"')).toEqual({
      kind: "compare",
      name: "mode",
      value: "plan",
      equal: false,
    });
  });

  it("returns null for anything that does not parse", () => {
    expect(parseWhen("a &&")).toBeNull();
    expect(parseWhen("a b")).toBeNull();
    expect(parseWhen("(a")).toBeNull();
    expect(parseWhen("a == ")).toBeNull();
    expect(parseWhen("a & b")).toBeNull();
  });
});
