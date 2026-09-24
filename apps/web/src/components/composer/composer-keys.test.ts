import { describe, expect, it } from "vitest";

import { composerEnter, menuMove, type ComposerEnterInput } from "./composer-keys";

const input = (patch: Partial<ComposerEnterInput> = {}): ComposerEnterInput => ({
  triggerOpen: false,
  menuItemCount: 0,
  shiftKey: false,
  chord: false,
  composing: false,
  ...patch,
});

describe("composerEnter", () => {
  it("picks from an open menu that has something to pick", () => {
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 3 }))).toBe("pick");
  });

  it("sends when the open menu has no matches", () => {
    // The regression: typing "what is in /etc/hosts" opens a slash trigger with
    // no matching commands, and Enter did nothing at all — it neither picked,
    // nor closed the menu, nor sent, so the message could not be sent until the
    // user discovered Escape.
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 0 }))).toBe("send");
  });

  it("sends with no menu open", () => {
    expect(composerEnter(input())).toBe("send");
  });

  it("leaves Shift+Enter to the textarea", () => {
    expect(composerEnter(input({ shiftKey: true }))).toBe("insert");
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 0, shiftKey: true }))).toBe(
      "insert",
    );
  });

  it("leaves a composing IME alone", () => {
    expect(composerEnter(input({ composing: true }))).toBe("insert");
  });

  it("leaves a composing IME alone even while a menu has rows", () => {
    // An inline IME's uncommitted letters sit in the draft, so `@le` mid-pinyin
    // can have skill rows open; the Enter that commits the composition must not
    // pick one of them.
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 3, composing: true }))).toBe(
      "insert",
    );
  });

  it("still picks for Shift+Enter while a populated menu is open", () => {
    // Unchanged: the menu owns Enter whenever it has a row under the cursor.
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 2, shiftKey: true }))).toBe(
      "pick",
    );
  });

  it("leaves Mod+Enter to the keymap instead of sending it", () => {
    // `composer.queue` is a table row: claiming the chord here meant a
    // rebinding changed the palette's label but not the key in the composer.
    expect(composerEnter(input({ chord: true }))).toBe("keymap");
    expect(composerEnter(input({ chord: true, shiftKey: true }))).toBe("keymap");
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 0, chord: true }))).toBe(
      "keymap",
    );
  });

  it("lets an open menu with rows pick before the keymap sees a chord", () => {
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 2, chord: true }))).toBe("pick");
  });

  it("leaves a chord pressed mid-composition to the IME", () => {
    expect(composerEnter(input({ chord: true, composing: true }))).toBe("insert");
  });
});

describe("menuMove", () => {
  it("moves down on ArrowDown and Tab, wrapping to the first row", () => {
    expect(menuMove("ArrowDown", false, 0, 3)).toBe(1);
    expect(menuMove("Tab", false, 1, 3)).toBe(2);
    expect(menuMove("ArrowDown", false, 2, 3)).toBe(0);
  });

  it("moves up on ArrowUp and Shift+Tab, wrapping to the last row", () => {
    expect(menuMove("ArrowUp", false, 2, 3)).toBe(1);
    expect(menuMove("Tab", true, 1, 3)).toBe(0);
    expect(menuMove("ArrowUp", false, 0, 3)).toBe(2);
  });

  it("stays on row 0 in an empty menu", () => {
    expect(menuMove("ArrowDown", false, 0, 0)).toBe(0);
    expect(menuMove("ArrowUp", false, 0, 0)).toBe(0);
  });

  it("leaves every other key alone", () => {
    expect(menuMove("Enter", false, 1, 3)).toBeNull();
    expect(menuMove("a", false, 1, 3)).toBeNull();
  });
});
