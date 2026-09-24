import { describe, expect, it } from "vitest";

import { canZoom, stepZoom, zoomPercent } from "./zoom";

describe("zoom", () => {
  it("steps through the browser presets in percent", () => {
    const percents: Array<number> = [];
    let level = 0;
    for (let step = 0; step < 4; step += 1) {
      level = stepZoom(level, "in");
      percents.push(zoomPercent(level));
    }
    expect(percents).toEqual([110, 125, 150, 175]);
    for (let step = 0; step < 4; step += 1) level = stepZoom(level, "out");
    expect(zoomPercent(level)).toBe(100);
    expect(zoomPercent(stepZoom(0, "out"))).toBe(90);
  });

  it("stops at the ends", () => {
    let level = 0;
    for (let step = 0; step < 30; step += 1) level = stepZoom(level, "in");
    expect(zoomPercent(level)).toBe(500);
    expect(canZoom(level, "in")).toBe(false);
    for (let step = 0; step < 30; step += 1) level = stepZoom(level, "out");
    expect(zoomPercent(level)).toBe(25);
    expect(canZoom(level, "out")).toBe(false);
    expect(canZoom(0, "in") && canZoom(0, "out")).toBe(true);
  });

  it("moves from a level between presets to the next preset", () => {
    // Level 0.3 is 105.6%: in goes to 110, out to 100.
    expect(zoomPercent(stepZoom(0.3, "in"))).toBe(110);
    expect(zoomPercent(stepZoom(0.3, "out"))).toBe(100);
  });
});
