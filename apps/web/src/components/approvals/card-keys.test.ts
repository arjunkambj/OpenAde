import { describe, expect, it } from "vitest";

import { approvalCardKey, isOverlayOpen, planCardKey, type CardKeyContext } from "./card-keys";

const press = (patch: Partial<CardKeyContext> & { readonly key: string }): CardKeyContext => ({
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  editable: false,
  overlayOpen: false,
  ...patch,
});

describe("approvalCardKey", () => {
  it("answers the four decisions", () => {
    expect(approvalCardKey(press({ key: "1" }))).toBe("allow-once");
    expect(approvalCardKey(press({ key: "2" }))).toBe("allow-session");
    expect(approvalCardKey(press({ key: "3" }))).toBe("allow-always");
    expect(approvalCardKey(press({ key: "d" }))).toBe("deny");
    expect(approvalCardKey(press({ key: "D" }))).toBe("deny");
    expect(approvalCardKey(press({ key: "Escape" }))).toBe("deny");
  });

  it("does not deny while a dialog or menu is on screen", () => {
    // The regression: Cmd+K opened the palette, the first Escape blurred its
    // input, and the second one silently denied the pending tool call while the
    // palette was still up.
    expect(approvalCardKey(press({ key: "Escape", overlayOpen: true }))).toBeNull();
    expect(approvalCardKey(press({ key: "1", overlayOpen: true }))).toBeNull();
  });

  it("leaves the keys alone while focus is in a text field", () => {
    // It used to blur the field and swallow the event instead, which is how
    // Escape stopped reaching the composer's own trigger-menu handling.
    expect(approvalCardKey(press({ key: "Escape", editable: true }))).toBeNull();
    expect(approvalCardKey(press({ key: "2", editable: true }))).toBeNull();
  });

  it("does not answer an event something else already handled", () => {
    expect(approvalCardKey(press({ key: "Escape", defaultPrevented: true }))).toBeNull();
  });

  it("ignores chords", () => {
    expect(approvalCardKey(press({ key: "1", metaKey: true }))).toBeNull();
    expect(approvalCardKey(press({ key: "1", ctrlKey: true }))).toBeNull();
    expect(approvalCardKey(press({ key: "1", altKey: true }))).toBeNull();
  });

  it("claims nothing else", () => {
    expect(approvalCardKey(press({ key: "a" }))).toBeNull();
    expect(approvalCardKey(press({ key: "Enter" }))).toBeNull();
    expect(approvalCardKey(press({ key: "4" }))).toBeNull();
  });
});

describe("planCardKey", () => {
  it("answers the three plan actions", () => {
    expect(planCardKey(press({ key: "1" }))).toBe("accept");
    expect(planCardKey(press({ key: "2" }))).toBe("accept-auto");
    expect(planCardKey(press({ key: "3" }))).toBe("revise");
  });

  it("never claims Escape — a plan does not answer for the user", () => {
    expect(planCardKey(press({ key: "Escape" }))).toBeNull();
  });

  it("stands down for the same surfaces the approval card does", () => {
    expect(planCardKey(press({ key: "1", overlayOpen: true }))).toBeNull();
    expect(planCardKey(press({ key: "2", editable: true }))).toBeNull();
    expect(planCardKey(press({ key: "3", defaultPrevented: true }))).toBeNull();
  });
});

describe("isOverlayOpen", () => {
  /** A stand-in document: records the query and answers with `found`. */
  const root = (found: Element | null) => {
    const queries: Array<string> = [];
    return {
      queries,
      querySelector: (query: string) => {
        queries.push(query);
        return found;
      },
    };
  };

  it("asks for every surface that outranks a card", () => {
    const document = root(null);
    isOverlayOpen(document);
    for (const role of ["dialog", "alertdialog", "menu", "menubar", "listbox"]) {
      // `listbox` is the composer's own `/` and `#` menu, which is inline
      // rather than portalled and is exactly what used to lose Escape.
      expect(document.queries[0]).toContain(`[role="${role}"]`);
    }
  });

  it("is false with nothing in front, true with something", () => {
    expect(isOverlayOpen(root(null))).toBe(false);
    expect(isOverlayOpen(root({} as Element))).toBe(true);
  });
});
