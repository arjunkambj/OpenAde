import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "@OpenAde/contracts/settings";
import { resolveKeybinding } from "@OpenAde/client-runtime/keybindings";

import { effectiveKeybindings, keycapsFor, shortcutFor, yieldsToTerminal } from "./keybindings";

describe("effectiveKeybindings", () => {
  it("stands the shipped defaults in for an empty server table", () => {
    expect(effectiveKeybindings([])).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("leaves a populated table alone, removals included", () => {
    const table: ReadonlyArray<Keybinding> = [{ command: "thread.new", shortcut: "Cmd+J" }];
    expect(effectiveKeybindings(table)).toBe(table);
  });
});

describe("yieldsToTerminal", () => {
  it("lets the terminal toggle act from inside a focused terminal", () => {
    expect(yieldsToTerminal("terminal.toggle", "terminal")).toBe(false);
  });

  it("leaves every other chord to a focused terminal", () => {
    expect(yieldsToTerminal("thread.interrupt", "terminal")).toBe(true);
    expect(yieldsToTerminal("commandPalette.toggle", "terminal")).toBe(true);
    expect(yieldsToTerminal("sidebar.toggle", "terminal")).toBe(true);
  });

  it("yields nothing when the focus is anywhere else", () => {
    expect(yieldsToTerminal("thread.interrupt", "composer")).toBe(false);
    expect(yieldsToTerminal("commandPalette.toggle", "composer")).toBe(false);
    expect(yieldsToTerminal("commandPalette.toggle", undefined)).toBe(false);
  });
});

describe("shortcutFor", () => {
  it("finds the chord a command is bound to", () => {
    expect(shortcutFor(DEFAULT_KEYBINDINGS, "sidebar.toggle")).toBe("Cmd+B");
  });

  it("returns null for a command the table does not bind", () => {
    expect(shortcutFor(DEFAULT_KEYBINDINGS, "nothing.here")).toBeNull();
  });
});

describe("keycapsFor", () => {
  it("draws the platform modifier as a glyph on macOS", () => {
    expect(keycapsFor("Cmd+Shift+B", "meta")).toEqual(["⌘", "⇧", "B"]);
  });

  it("spells the modifiers out elsewhere", () => {
    expect(keycapsFor("Cmd+Shift+B", "ctrl")).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("does not draw Ctrl twice when Cmd already means Control", () => {
    expect(keycapsFor("Cmd+Ctrl+K", "ctrl")).toEqual(["Ctrl", "K"]);
  });

  it("labels named keys", () => {
    expect(keycapsFor("Escape", "meta")).toEqual(["Esc"]);
    expect(keycapsFor("Cmd+Enter", "meta")).toEqual(["⌘", "↵"]);
    expect(keycapsFor("Cmd+,", "meta")).toEqual(["⌘", ","]);
  });

  it("draws nothing for an unparseable chord", () => {
    expect(keycapsFor("Cmd+", "meta")).toEqual([]);
  });
});

describe("the default table and the matcher agree", () => {
  const press = (
    key: string,
    modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  const resolve = (event: ReturnType<typeof press>) =>
    resolveKeybinding(effectiveKeybindings([]), event, () => undefined, "meta")?.command ?? null;

  it("routes every chord the shell advertises to its command", () => {
    expect(resolve(press("k", { metaKey: true }))).toBe("commandPalette.toggle");
    expect(resolve(press("n", { metaKey: true }))).toBe("thread.new");
    expect(resolve(press("b", { metaKey: true }))).toBe("sidebar.toggle");
    expect(resolve(press("b", { metaKey: true, shiftKey: true }))).toBe("browserPane.toggle");
    expect(resolve(press("s", { metaKey: true, shiftKey: true }))).toBe("skills.open");
    expect(resolve(press(",", { metaKey: true }))).toBe("settings.open");
    expect(resolve(press("Enter", { metaKey: true }))).toBe("composer.queue");
    expect(resolve(press("Escape"))).toBe("thread.interrupt");
    expect(resolve(press("j", { metaKey: true }))).toBe("terminal.toggle");
  });

  it("does not fire a bare chord when an extra modifier is held", () => {
    expect(resolve(press("Escape", { shiftKey: true }))).toBeNull();
  });
});
