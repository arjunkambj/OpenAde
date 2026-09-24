import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANCHOR_OFFSET, holdSettledAnchor, keepInView, placeAnchor } from "./list-hold";

// Animation frames run when the test says so, at the time it gives.
let frames = new Map<number, (now: number) => void>();
let nextFrame = 1;
const runFrame = (now: number) => {
  const pending = [...frames.values()];
  frames = new Map();
  for (const callback of pending) {
    callback(now);
  }
};

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const holding = async () => {
  const state = { scroll: 0, contentLength: 2000, scrollLength: 600, positionByKey: () => 400 };
  const scrollToIndex = vi.fn(() => Promise.resolve());
  const list = { getState: () => state, scrollToIndex } as unknown as LegendListRef;
  const placed = vi.fn();
  const cancel = placeAnchor({
    list,
    rowId: "u2",
    indexOf: () => 3,
    // The reserve under the row is already measured, so the approach starts now.
    reserved: { key: "u2", waiters: new Set() },
    onPlaced: placed,
  });
  // The eased approach resolves, and the hold begins.
  await vi.waitFor(() => expect(placed).toHaveBeenCalled());
  runFrame(16);
  scrollToIndex.mockClear();
  return { state, scrollToIndex, cancel };
};

describe("placeAnchor", () => {
  it("puts the row back whenever the list moves under it while held", async () => {
    const { state, scrollToIndex, cancel } = await holding();
    state.scroll = 120;
    runFrame(32);
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 3, viewPosition: 0, animated: false }),
    );
    cancel();
  });

  it("leaves the reader's scroll alone once stopped, even with a frame still due", async () => {
    const { state, scrollToIndex, cancel } = await holding();
    // The reader's wheel moves the list and stops the hold in the same event,
    // before any render; the frame after it must not scroll the row back.
    state.scroll = 120;
    cancel();
    runFrame(32);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

describe("keepInView", () => {
  const fakeList = (positions: Record<string, number>, scrollTop: number) => {
    // No content element, so no top padding to read.
    const node = { scrollTop, firstElementChild: null };
    const list = {
      getScrollableNode: () => node,
      getState: () => ({
        indexByKey: (key: string) => (key in positions ? 0 : undefined),
        positionByKey: (key: string) => positions[key],
      }),
    } as unknown as LegendListRef;
    return { list, node };
  };

  beforeEach(() => {
    vi.stubGlobal("HTMLElement", class {});
  });

  it("puts the reader's row back before paint, then on every frame it moves", () => {
    // Expand-all opened folds above: the row the reader had 50px down now sits
    // 1,700px further down the content.
    const positions: Record<string, number> = { a1: 2000 };
    const { list, node } = fakeList(positions, 250);
    const cancel = keepInView(list, [{ rowId: "a1", offset: 50 }]);
    expect(node.scrollTop).toBe(1950);
    // The rows above settle to their measured heights a frame later.
    positions.a1 = 2100;
    runFrame(16);
    expect(node.scrollTop).toBe(2050);
    // Stopped by the reader's scroll: the row may move from here.
    cancel();
    positions.a1 = 2200;
    runFrame(32);
    expect(node.scrollTop).toBe(2050);
  });

  it("holds the first anchor whose row the list still has", () => {
    // Collapse-all folded away the row at the top; the next one on screen holds.
    const { list, node } = fakeList({ u2: 300 }, 1000);
    keepInView(list, [
      { rowId: "a1", offset: -20 },
      { rowId: "u2", offset: 80 },
    ]);
    expect(node.scrollTop).toBe(220);
  });

  it("leaves the scroll alone when no anchor survived", () => {
    const { list, node } = fakeList({}, 1000);
    keepInView(list, [{ rowId: "a1", offset: 0 }])();
    runFrame(16);
    expect(node.scrollTop).toBe(1000);
  });

  it("holds a settled turn's message at the top before paint, with no eased scroll", () => {
    // The message sits at 7,000. The turn's work folded away under it and the
    // browser clamped the scroll 329px down before the reserve caught up.
    const { list, node } = fakeList({ u2: 7000 }, 7000 - ANCHOR_OFFSET - 329);
    const scrollToIndex = vi.fn(() => Promise.resolve());
    Object.assign(list, { scrollToIndex });
    const cancel = holdSettledAnchor(list, "u2");
    expect(node.scrollTop).toBe(7000 - ANCHOR_OFFSET);
    // Clamped again on the next frame, before the reserve grew: put back again.
    node.scrollTop = 6800;
    runFrame(16);
    expect(node.scrollTop).toBe(7000 - ANCHOR_OFFSET);
    expect(scrollToIndex).not.toHaveBeenCalled();
    cancel();
  });

  it("lets go once the rows have been still for a while", () => {
    const positions: Record<string, number> = { a1: 500 };
    const { list, node } = fakeList(positions, 450);
    keepInView(list, [{ rowId: "a1", offset: 50 }]);
    runFrame(16);
    runFrame(1_000);
    expect(frames.size).toBe(0);
    positions.a1 = 900;
    runFrame(1_016);
    expect(node.scrollTop).toBe(450);
  });
});
