import { describe, expect, it } from "vitest";

import { formatPixel, themeFromPixels, withAlpha, type Pixel } from "./terminal-theme";

describe("formatPixel", () => {
  it("writes an opaque pixel as rgb()", () => {
    expect(formatPixel([24, 24, 27, 255])).toBe("rgb(24, 24, 27)");
  });

  it("writes a translucent pixel as rgba() with alpha to three places", () => {
    expect(formatPixel([250, 250, 250, 64])).toBe("rgba(250, 250, 250, 0.251)");
    expect(formatPixel([0, 0, 0, 0])).toBe("rgba(0, 0, 0, 0)");
  });

  it("rounds and clamps each channel", () => {
    expect(formatPixel([-3, 12.6, 300, 255.4])).toBe("rgb(0, 13, 255)");
  });
});

describe("withAlpha", () => {
  it("scales the alpha and keeps the colour", () => {
    expect(withAlpha([10, 20, 30, 255], 0.25)).toEqual([10, 20, 30, 63.75]);
  });
});

describe("themeFromPixels", () => {
  const background: Pixel = [255, 255, 255, 255];
  const foreground: Pixel = [24, 24, 27, 255];

  it("takes the surface from the tokens and the cursor from the foreground", () => {
    expect(themeFromPixels({ background, foreground })).toEqual({
      background: "rgb(255, 255, 255)",
      foreground: "rgb(24, 24, 27)",
      cursor: "rgb(24, 24, 27)",
      selectionBackground: "rgba(24, 24, 27, 0.251)",
    });
  });

  it("leaves out what could not be resolved, so xterm keeps its own", () => {
    expect(themeFromPixels({ background: null, foreground: null })).toEqual({});
    expect(themeFromPixels({ background, foreground: null })).toEqual({
      background: "rgb(255, 255, 255)",
    });
  });

  it("names no ANSI colour", () => {
    expect(Object.keys(themeFromPixels({ background, foreground }))).not.toContain("red");
  });
});
