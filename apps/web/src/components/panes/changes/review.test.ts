/**
 * The Changes pane's review rules: every file starts closed, the thread's own
 * choices stick per path, and a viewed mark lapses when its patch changes.
 */

import { describe, expect, it } from "vitest";

import { emptyChangesReview } from "@/state/ui";

import {
  everyFileOpen,
  isOpen,
  isViewed,
  patchHash,
  stepFile,
  viewedCount,
  withOpen,
  withViewed,
} from "./review";

describe("changes review", () => {
  it("starts every file closed and keeps the user's choice per path", () => {
    expect(isOpen(emptyChangesReview, "src/a.ts")).toBe(false);
    const review = withOpen(emptyChangesReview, ["src/a.ts"], true);
    expect(isOpen(review, "src/a.ts")).toBe(true);
    // A path never touched stays closed.
    expect(isOpen(review, "src/b.ts")).toBe(false);
    expect(isOpen(withOpen(review, ["src/a.ts"], false), "src/a.ts")).toBe(false);
  });

  it("opens or closes many paths at once and leaves the rest alone", () => {
    const start = withOpen(emptyChangesReview, ["keep.ts"], true);
    const closed = withOpen(start, ["a.ts", "b.ts"], false);
    expect(closed.open).toEqual({ "keep.ts": true, "a.ts": false, "b.ts": false });
    // The input is not written to.
    expect(start.open).toEqual({ "keep.ts": true });
  });

  it("collapses all only once every file with a patch is open", () => {
    const files = [
      { path: "a.ts", diff: "@@ a" },
      { path: "b.ts", diff: "@@ b" },
      // A binary or mode-only change has no patch, so it never counts.
      { path: "logo.png", diff: "" },
    ];
    expect(everyFileOpen(emptyChangesReview, files)).toBe(false);
    expect(everyFileOpen(withOpen(emptyChangesReview, ["a.ts"], true), files)).toBe(false);
    expect(everyFileOpen(withOpen(emptyChangesReview, ["a.ts", "b.ts"], true), files)).toBe(true);
    // Nothing to open is nothing to collapse.
    expect(everyFileOpen(emptyChangesReview, [{ path: "logo.png", diff: "" }])).toBe(false);
  });

  it("marks a file viewed and closes it, and the mark lapses when its patch changes", () => {
    const before = "@@ -1 +1 @@\n-a\n+b\n";
    const after = "@@ -1 +1 @@\n-a\n+c\n";
    const opened = withOpen(emptyChangesReview, ["a.ts"], true);
    const viewed = withViewed(opened, "a.ts", patchHash(before));
    expect(isViewed(viewed, "a.ts", patchHash(before))).toBe(true);
    expect(isOpen(viewed, "a.ts")).toBe(false);
    // The agent edits the file again: the mark no longer holds, with nothing
    // having to reset it, and the file keeps the closed state it was left in.
    expect(isViewed(viewed, "a.ts", patchHash(after))).toBe(false);
    expect(isOpen(viewed, "a.ts")).toBe(false);
    // Unmarking drops the mark and leaves the file as it was.
    const unmarked = withViewed(withOpen(viewed, ["a.ts"], true), "a.ts", null);
    expect(isViewed(unmarked, "a.ts", patchHash(before))).toBe(false);
    expect(isOpen(unmarked, "a.ts")).toBe(true);
  });

  it("fingerprints a patch by its text, cheaply and stably", () => {
    expect(patchHash("+a")).toBe(patchHash("+a"));
    expect(patchHash("+a")).not.toBe(patchHash("+b"));
    expect(patchHash("")).not.toBe(patchHash(" "));
  });

  it("counts only the marks that still hold", () => {
    const review = withViewed(withViewed(emptyChangesReview, "a.ts", "h1"), "b.ts", "h2");
    const files = [
      { path: "a.ts", hash: "h1" },
      // b.ts changed since it was marked.
      { path: "b.ts", hash: "h3" },
      { path: "c.ts", hash: "h4" },
    ];
    expect(viewedCount(review, files)).toBe(1);
  });

  describe("next and previous file", () => {
    // Five 100px files, the view 250px tall.
    const at = (scrolled: number) => [0, 100, 200, 300, 400].map((top) => top - scrolled);

    it("starts from the top: next opens the first file, previous has nowhere to go", () => {
      expect(stepFile(at(0), 250, -1, 1)).toBe(0);
      expect(stepFile(at(0), 250, -1, -1)).toBeNull();
    });

    it("steps from the file it last moved to while that file is on screen", () => {
      expect(stepFile(at(100), 250, 1, 1)).toBe(2);
      expect(stepFile(at(100), 250, 1, -1)).toBe(0);
      // Scrolled to the bottom, the last files cannot reach the top edge, and
      // the keys still walk through them one by one.
      expect(stepFile(at(250), 250, 3, 1)).toBe(4);
      expect(stepFile(at(250), 250, 4, 1)).toBeNull();
    });

    it("goes by what shows once the user has scrolled the cursor away", () => {
      // Reading the middle of file 2, with file 0 the cursor.
      expect(stepFile(at(250), 250, 0, 1)).toBe(3);
      // Previous goes back to the start of the file being read first.
      expect(stepFile(at(250), 250, 0, -1)).toBe(2);
    });

    it("has nothing to step through in an empty list", () => {
      expect(stepFile([], 250, -1, 1)).toBeNull();
    });
  });
});
