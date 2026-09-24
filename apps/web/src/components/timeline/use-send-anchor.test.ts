import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { placeAnchor } from "./use-send-anchor";

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
