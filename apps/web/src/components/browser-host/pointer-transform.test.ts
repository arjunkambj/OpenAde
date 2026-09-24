import { describe, expect, it } from "vitest";

import { pointerOnPane } from "./pointer-transform";

const box = { x: 100, y: 50, width: 400, height: 300 };

describe("pointerOnPane", () => {
  it("offsets a point by the webview's box at 100%", () => {
    expect(pointerOnPane({ x: 10, y: 20 }, box, 0)).toEqual({ x: 110, y: 70 });
  });

  it("scales by the tab's zoom", () => {
    const point = pointerOnPane({ x: 100, y: 100 }, box, 1);
    expect(point?.x).toBeCloseTo(220);
    expect(point?.y).toBeCloseTo(170);
  });

  it("draws nothing outside the box", () => {
    expect(pointerOnPane({ x: 401, y: 10 }, box, 0)).toBe(null);
    expect(pointerOnPane({ x: 10, y: -1 }, box, 0)).toBe(null);
    expect(pointerOnPane({ x: 350, y: 10 }, box, 1)).toBe(null);
  });
});
