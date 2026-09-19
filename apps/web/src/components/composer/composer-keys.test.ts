import { describe, expect, it } from "vitest";

import { composerEnter, type ComposerEnterInput } from "./composer-keys";

const input = (patch: Partial<ComposerEnterInput> = {}): ComposerEnterInput => ({
  triggerOpen: false,
  menuItemCount: 0,
  shiftKey: false,
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

  it("still picks for Shift+Enter while a populated menu is open", () => {
    // Unchanged: the menu owns Enter whenever it has a row under the cursor.
    expect(composerEnter(input({ triggerOpen: true, menuItemCount: 2, shiftKey: true }))).toBe(
      "pick",
    );
  });
});
