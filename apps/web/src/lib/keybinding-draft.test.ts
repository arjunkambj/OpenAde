import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "@poseidon/contracts/keybindings";
import type { Keybinding } from "@poseidon/contracts/settings";

import {
  addBinding,
  commandBindings,
  draftIssues,
  draftOverrides,
  modifiedCommands,
  normalizeDraft,
  patchBinding,
  removeBinding,
  resetAll,
  resetCommand,
  sameDraft,
  unknownCommands,
} from "./keybinding-draft";
import { effectiveKeybindings } from "./keybindings";

const defaults = effectiveKeybindings([]);

const indexOf = (draft: ReadonlyArray<Keybinding>, command: string, nth = 0): number =>
  commandBindings(draft, command)[nth]!.index;

describe("the keybinding draft", () => {
  it("starts on the defaults with nothing modified", () => {
    expect(resetAll()).toEqual(DEFAULT_KEYBINDINGS);
    expect(draftOverrides(defaults)).toEqual([]);
    expect(modifiedCommands(defaults).size).toBe(0);
  });

  it("marks a rebound command Modified and diffs it to its replacement rows", () => {
    const draft = patchBinding(defaults, indexOf(defaults, "sidebar.toggle"), {
      shortcut: "Mod+Alt+S",
    });
    expect(modifiedCommands(draft)).toEqual(new Set(["sidebar.toggle"]));
    expect(draftOverrides(draft)).toEqual([{ command: "sidebar.toggle", shortcut: "Mod+Alt+S" }]);
    // The override row now leads the table, as it will after a reload.
    expect(draft[0]).toEqual({ command: "sidebar.toggle", shortcut: "Mod+Alt+S" });
    expect(sameDraft(draft, normalizeDraft(draft))).toBe(true);
  });

  it("edits and clears a when clause", () => {
    const scoped = patchBinding(defaults, indexOf(defaults, "sidebar.toggle"), {
      when: "!inputFocus",
    });
    expect(draftOverrides(scoped)).toEqual([
      { command: "sidebar.toggle", shortcut: "Mod+B", when: "!inputFocus" },
    ]);
    const cleared = patchBinding(scoped, indexOf(scoped, "sidebar.toggle"), { when: "" });
    expect(draftOverrides(cleared)).toEqual([]);
    expect(modifiedCommands(cleared).size).toBe(0);
  });

  it("stores a command whose last binding was removed as unbound", () => {
    const draft = removeBinding(defaults, indexOf(defaults, "sidebar.toggle"));
    expect(commandBindings(draft, "sidebar.toggle")).toEqual([]);
    expect(draftOverrides(draft)).toEqual([{ command: "-sidebar.toggle", shortcut: "Mod+B" }]);
    expect(modifiedCommands(draft)).toEqual(new Set(["sidebar.toggle"]));
  });

  it("removes one of two bindings and keeps the other", () => {
    const draft = removeBinding(defaults, indexOf(defaults, "approval.deny", 1));
    expect(commandBindings(draft, "approval.deny").map((entry) => entry.binding.shortcut)).toEqual([
      "D",
    ]);
    expect(draftOverrides(draft)).toHaveLength(1);
  });

  it("adds another binding after the command's own rows", () => {
    const draft = addBinding(defaults, "commandPalette.toggle", "Mod+Shift+P");
    expect(
      commandBindings(draft, "commandPalette.toggle").map((entry) => entry.binding.shortcut),
    ).toEqual(["Mod+K", "Mod+Shift+P"]);
    expect(draftOverrides(draft)).toEqual([
      { command: "commandPalette.toggle", shortcut: "Mod+K" },
      { command: "commandPalette.toggle", shortcut: "Mod+Shift+P" },
    ]);
    expect(addBinding(draft, "commandPalette.toggle", "Mod+Shift+P")).toBe(draft);
    // An unbound command gets its first chord the same way.
    expect(draftOverrides(addBinding(defaults, "mcp.open", "Mod+Alt+M"))).toEqual([
      { command: "mcp.open", shortcut: "Mod+Alt+M" },
    ]);
  });

  it("resets one command and leaves the others", () => {
    let draft = patchBinding(defaults, indexOf(defaults, "sidebar.toggle"), {
      shortcut: "Mod+Alt+S",
    });
    draft = removeBinding(draft, indexOf(draft, "settings.open"));
    const reset = resetCommand(draft, "settings.open");
    expect(draftOverrides(reset)).toEqual([{ command: "sidebar.toggle", shortcut: "Mod+Alt+S" }]);
    expect(commandBindings(reset, "settings.open").map((entry) => entry.binding.shortcut)).toEqual([
      "Mod+,",
    ]);
    expect(draftOverrides(resetCommand(reset, "sidebar.toggle"))).toEqual([]);
  });

  it("drops an unknown command on reset and lists it until then", () => {
    const draft = normalizeDraft([...defaults, { command: "future.thing", shortcut: "Mod+Alt+F" }]);
    const known = new Set(DEFAULT_KEYBINDINGS.map((row) => row.command));
    expect(unknownCommands(draft, known)).toEqual(["future.thing"]);
    expect(unknownCommands(resetCommand(draft, "future.thing"), known)).toEqual([]);
  });

  it("resets everything to no overrides", () => {
    const draft = removeBinding(defaults, indexOf(defaults, "thread.new"));
    expect(draftOverrides(resetAll())).toEqual([]);
    expect(sameDraft(draft, resetAll())).toBe(false);
    expect(sameDraft(resetAll(), defaults)).toBe(true);
  });

  it("treats drafts that store the same overrides as the same", () => {
    const stored = effectiveKeybindings([
      { command: "a.one", shortcut: "Mod+Alt+1" },
      { command: "b.two", shortcut: "Mod+Alt+2" },
      { command: "a.one", shortcut: "Mod+Alt+3" },
    ]);
    expect(sameDraft(stored, normalizeDraft(stored))).toBe(true);
  });
});

describe("draftIssues", () => {
  it("reports nothing for the defaults", () => {
    for (const platform of ["meta", "ctrl"] as const) {
      const issues = draftIssues(defaults, platform);
      expect(issues.filter((issue) => issue.conflicts.length > 0)).toEqual([]);
      expect(issues.filter((issue) => issue.reserved !== null)).toEqual([]);
      expect(issues.filter((issue) => issue.invalidShortcut || issue.invalidWhen)).toEqual([]);
    }
  });

  it("flags an override that collides with a default in an overlapping context", () => {
    const draft = patchBinding(defaults, indexOf(defaults, "thread.rename"), {
      shortcut: "Mod+K",
    });
    const issues = draftIssues(draft, "meta");
    expect(issues[indexOf(draft, "thread.rename")]!.conflicts).toEqual([
      { command: "commandPalette.toggle", wins: true },
    ]);
    expect(issues[indexOf(draft, "commandPalette.toggle")]!.conflicts).toEqual([
      { command: "thread.rename", wins: false },
    ]);
  });

  it("keeps apart bindings whose contexts cannot hold together", () => {
    // `1` is both approval.allowOnce and plan.accept by default: never both pending.
    const allowOnce = indexOf(defaults, "approval.allowOnce");
    const planAccept = indexOf(defaults, "plan.accept");
    expect(defaults[allowOnce]!.shortcut).toBe(defaults[planAccept]!.shortcut);
    const issues = draftIssues(defaults, "meta");
    expect(issues[allowOnce]!.conflicts).toEqual([]);
    expect(issues[planAccept]!.conflicts).toEqual([]);
    // Moving allowSession onto `1` in the approval context does collide.
    const draft = patchBinding(defaults, indexOf(defaults, "approval.allowSession"), {
      shortcut: "1",
    });
    const moved = draftIssues(draft, "meta");
    expect(moved[indexOf(draft, "approval.allowSession")]!.conflicts).toEqual([
      { command: "approval.allowOnce", wins: true },
    ]);
    expect(moved[indexOf(draft, "plan.accept")]!.conflicts).toEqual([]);
  });

  it("checks conflicts on the given platform only", () => {
    const draft = addBinding(defaults, "sidebar.toggle", "Ctrl+K");
    const row = indexOf(draft, "sidebar.toggle", 1);
    expect(draftIssues(draft, "meta")[row]!.conflicts).toEqual([]);
    // The override leads the table, so it is the one that fires.
    expect(draftIssues(draft, "ctrl")[row]!.conflicts).toEqual([
      { command: "commandPalette.toggle", wins: true },
    ]);
  });

  it("warns on a system chord, an invalid chord and an unparseable clause", () => {
    let draft = patchBinding(defaults, indexOf(defaults, "sidebar.toggle"), { shortcut: "Mod+W" });
    draft = patchBinding(draft, indexOf(draft, "settings.open"), { shortcut: "Mod+Shift" });
    draft = patchBinding(draft, indexOf(draft, "font.reset"), { when: "threadOpen &&" });
    const issues = draftIssues(draft, "meta");
    expect(issues[indexOf(draft, "sidebar.toggle")]!.reserved).toBe("Closes the window");
    expect(issues[indexOf(draft, "settings.open")]!.invalidShortcut).toBe(true);
    expect(issues[indexOf(draft, "font.reset")]!.invalidWhen).toBe(true);
  });
});
