import { describe, expect, it } from "vitest";

import { DEFAULT_HIDDEN_SIZE, hiddenRect, placeTab, visibleRect, type Rect } from "./host-geometry";

const VIEWPORT = { width: 1440, height: 900 };
const PANE: Rect = { x: 1000, y: 88, width: 420, height: 780 };

/** Inside the viewport, with a real size. */
const laidOut = (rect: Rect, viewport = VIEWPORT) => {
  expect(rect.width).toBeGreaterThanOrEqual(1);
  expect(rect.height).toBeGreaterThanOrEqual(1);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
};

describe("hiddenRect", () => {
  it("keeps the pane's last rect when it fits", () => {
    expect(hiddenRect(PANE, VIEWPORT)).toEqual(PANE);
  });

  it("falls back to the default size at the origin when no pane was ever shown", () => {
    const rect = hiddenRect(null, VIEWPORT);
    expect(rect).toEqual({ x: 0, y: 0, ...DEFAULT_HIDDEN_SIZE });
    laidOut(rect);
  });

  it("moves a rect that spills past the viewport back inside, keeping its size", () => {
    const rect = hiddenRect({ x: 1300, y: 600, width: 420, height: 780 }, VIEWPORT);
    expect(rect).toEqual({ x: 1020, y: 120, width: 420, height: 780 });
    laidOut(rect);
    laidOut(hiddenRect({ x: -500, y: -40, width: 420, height: 300 }, VIEWPORT));
  });

  it("shrinks to the viewport once the window is smaller than the pane was", () => {
    const small = { width: 600, height: 400 };
    const rect = hiddenRect(PANE, small);
    expect(rect).toEqual({ x: 180, y: 0, width: 420, height: 400 });
    laidOut(rect, small);
    laidOut(hiddenRect(null, small), small);
  });

  it("is never 0×0, even for a collapsed pane or viewport", () => {
    const tiny = hiddenRect({ x: 10, y: 10, width: 0, height: 0 }, VIEWPORT);
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBe(1);
    const none = hiddenRect(PANE, { width: 0, height: 0 });
    expect(none).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("visibleRect", () => {
  it("rounds a slot's rect and has none without area", () => {
    expect(visibleRect({ x: 10.4, y: 20.6, width: 300.5, height: 200.2 })).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 200,
    });
    expect(visibleRect({ x: 0, y: 0, width: 0, height: 400 })).toBeNull();
    expect(visibleRect(null)).toBeNull();
  });
});

describe("placeTab", () => {
  const slot = { threadId: "a", rect: PANE };

  it("lays the selected tab of the pane's thread over the slot", () => {
    expect(placeTab({ threadId: "a", selected: true }, slot, PANE, VIEWPORT)).toEqual({
      rect: PANE,
      visible: true,
    });
  });

  it("hides every other tab at the pane's last rect", () => {
    const hidden = { rect: PANE, visible: false };
    expect(placeTab({ threadId: "a", selected: false }, slot, PANE, VIEWPORT)).toEqual(hidden);
    expect(placeTab({ threadId: "b", selected: true }, slot, PANE, VIEWPORT)).toEqual(hidden);
    // The pane closed, or showing another dock tab: no slot at all.
    expect(placeTab({ threadId: "a", selected: true }, null, PANE, VIEWPORT)).toEqual(hidden);
    // A slot collapsed to nothing shows nothing.
    const collapsed = { threadId: "a", rect: { ...PANE, width: 0 } };
    expect(placeTab({ threadId: "a", selected: true }, collapsed, PANE, VIEWPORT).visible).toBe(
      false,
    );
  });
});
