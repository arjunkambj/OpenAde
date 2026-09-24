import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  liveSelection,
  selectGestureOf,
  selectThreads,
  selectedRows,
  type ThreadSelection,
} from "./thread-selection";

const order = ["a", "b", "c", "d", "e"].map((threadId) => ({ threadId }));

const selection = (ids: ReadonlyArray<string>, anchor: string | null): ThreadSelection => ({
  ids: new Set(ids),
  anchor,
});

const ids = (value: ThreadSelection) => [...value.ids].sort();

describe("selectGestureOf", () => {
  it("reads Shift as a range, Cmd or Ctrl as a toggle, and nothing as a plain click", () => {
    const keys = { shiftKey: false, metaKey: false, ctrlKey: false };
    expect(selectGestureOf({ ...keys, shiftKey: true })).toBe("range");
    expect(selectGestureOf({ ...keys, metaKey: true })).toBe("toggle");
    expect(selectGestureOf({ ...keys, ctrlKey: true })).toBe("toggle");
    expect(selectGestureOf({ ...keys, shiftKey: true, metaKey: true })).toBe("range");
    expect(selectGestureOf(keys)).toBeNull();
  });
});

describe("selectThreads", () => {
  it("starts a toggle from the open thread, so the first Cmd-click selects two rows", () => {
    const next = selectThreads(order, EMPTY_SELECTION, "b", "d", "toggle");
    expect(ids(next)).toEqual(["b", "d"]);
    expect(next.anchor).toBe("d");
  });

  it("toggles a single row when no thread is open", () => {
    expect(ids(selectThreads(order, EMPTY_SELECTION, null, "c", "toggle"))).toEqual(["c"]);
  });

  it("takes a selected row back out on a second toggle", () => {
    const next = selectThreads(order, selection(["b", "d"], "d"), "b", "b", "toggle");
    expect(ids(next)).toEqual(["d"]);
  });

  it("selects from the open thread to the clicked row on the first Shift-click", () => {
    const next = selectThreads(order, EMPTY_SELECTION, "d", "b", "range");
    expect(ids(next)).toEqual(["b", "c", "d"]);
    expect(next.anchor).toBe("d");
  });

  it("redraws the range from the same anchor on the next Shift-click", () => {
    const first = selectThreads(order, selection(["b"], "b"), null, "d", "range");
    expect(ids(first)).toEqual(["b", "c", "d"]);
    const second = selectThreads(order, first, null, "a", "range");
    expect(ids(second)).toEqual(["a", "b"]);
    expect(second.anchor).toBe("b");
  });

  it("selects only the clicked row on a Shift-click with no anchor and no open thread", () => {
    const next = selectThreads(order, EMPTY_SELECTION, null, "c", "range");
    expect(ids(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("falls back to the open thread when the anchor has left the list", () => {
    const next = selectThreads(order, selection(["gone"], "gone"), "e", "c", "range");
    expect(ids(next)).toEqual(["c", "d", "e"]);
  });
});

describe("liveSelection", () => {
  it("drops rows that are no longer listed", () => {
    const next = liveSelection(order, selection(["a", "gone"], "gone"));
    expect(ids(next)).toEqual(["a"]);
    expect(next.anchor).toBeNull();
  });

  it("returns the same selection when every row is still listed", () => {
    const current = selection(["a", "c"], "c");
    expect(liveSelection(order, current)).toBe(current);
  });
});

describe("selectedRows", () => {
  it("lists the selected rows in sidebar order, whatever order they were picked in", () => {
    const rows = selectedRows(order, selection(["e", "a", "c"], "c"));
    expect(rows.map((row) => row.threadId)).toEqual(["a", "c", "e"]);
  });
});
