import { describe, expect, it } from "vitest";

import { DOCK_RESIZE_STEP, dockWidthForKey } from "./dock-resize";

const bounds = { min: 280, max: 900 };

describe("dockWidthForKey", () => {
  it("widens on Left and narrows on Right, a step at a time", () => {
    expect(dockWidthForKey("ArrowLeft", false, 480, bounds)).toBe(480 + DOCK_RESIZE_STEP);
    expect(dockWidthForKey("ArrowRight", false, 480, bounds)).toBe(480 - DOCK_RESIZE_STEP);
  });

  it("takes a bigger step with Shift", () => {
    expect(dockWidthForKey("ArrowLeft", true, 480, bounds)).toBe(480 + 4 * DOCK_RESIZE_STEP);
  });

  it("stays inside the bounds", () => {
    expect(dockWidthForKey("ArrowLeft", true, 890, bounds)).toBe(900);
    expect(dockWidthForKey("ArrowRight", false, 285, bounds)).toBe(280);
  });

  it("ignores other keys", () => {
    expect(dockWidthForKey("ArrowUp", false, 480, bounds)).toBeNull();
    expect(dockWidthForKey("Enter", false, 480, bounds)).toBeNull();
  });
});
