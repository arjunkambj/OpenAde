import { describe, expect, it } from "vitest";

import { stripScrollDelta } from "./drawer-parts";

describe("stripScrollDelta", () => {
  it("turns a vertical wheel into a sideways scroll", () => {
    expect(stripScrollDelta({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 600)).toBe(120);
    expect(stripScrollDelta({ deltaX: 0, deltaY: -40, deltaMode: 0 }, 600)).toBe(-40);
  });

  it("keeps a mostly sideways swipe's own direction", () => {
    expect(stripScrollDelta({ deltaX: -30, deltaY: 4, deltaMode: 0 }, 600)).toBe(-30);
  });

  it("scales line and page deltas to pixels", () => {
    expect(stripScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toBe(48);
    expect(stripScrollDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toBe(600);
  });
});
