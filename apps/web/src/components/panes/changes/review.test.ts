/**
 * The Changes pane's review rules: which files start open, and how the
 * thread's own choices override that default per path.
 */

import { describe, expect, it } from "vitest";

import { emptyChangesReview } from "@/state/ui";

import { everyFileOpen, isOpen, OPEN_LINES_LIMIT, startsOpen, withOpen } from "./review";

const file = (additions: number, deletions = 0) => ({ additions, deletions });

describe("changes review", () => {
  it("opens only a lone file small enough to read at a glance", () => {
    expect(startsOpen([file(12, 3)])).toBe(true);
    expect(startsOpen([file(OPEN_LINES_LIMIT - 100, 100)])).toBe(true);
    // One line over the guard, and the lone file starts closed too.
    expect(startsOpen([file(OPEN_LINES_LIMIT, 1)])).toBe(false);
    // Two small files are already a list to scan, so both start closed.
    expect(startsOpen([file(1), file(1)])).toBe(false);
    expect(startsOpen([])).toBe(false);
  });

  it("keeps the user's choice per path over the list's default", () => {
    const review = withOpen(emptyChangesReview, ["src/a.ts"], true);
    expect(isOpen(review, "src/a.ts", false)).toBe(true);
    // A path never touched follows whatever the list says.
    expect(isOpen(review, "src/b.ts", false)).toBe(false);
    expect(isOpen(review, "src/b.ts", true)).toBe(true);
    // Closing a lone small file sticks, though it would start open.
    expect(isOpen(withOpen(review, ["src/a.ts"], false), "src/a.ts", true)).toBe(false);
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
    expect(everyFileOpen(emptyChangesReview, files, false)).toBe(false);
    expect(everyFileOpen(withOpen(emptyChangesReview, ["a.ts"], true), files, false)).toBe(false);
    expect(everyFileOpen(withOpen(emptyChangesReview, ["a.ts", "b.ts"], true), files, false)).toBe(
      true,
    );
    // Nothing to open is nothing to collapse.
    expect(everyFileOpen(emptyChangesReview, [{ path: "logo.png", diff: "" }], true)).toBe(false);
  });
});
