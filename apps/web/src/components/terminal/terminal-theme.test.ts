import { describe, expect, it } from "vitest";

import {
  formatPixel,
  mixHex,
  searchDecorationsFromPixels,
  themeFromPixels,
  withAlpha,
  type Pixel,
} from "./terminal-theme";

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
      cursorAccent: "rgb(255, 255, 255)",
      selectionBackground: "rgba(24, 24, 27, 0.251)",
    });
  });

  it("leaves out what could not be resolved, so xterm keeps its own", () => {
    expect(themeFromPixels({ background: null, foreground: null })).toEqual({});
    expect(themeFromPixels({ background, foreground: null })).toEqual({
      background: "rgb(255, 255, 255)",
      cursorAccent: "rgb(255, 255, 255)",
    });
  });

  it("draws the glyph under the block cursor in the background, in either theme", () => {
    const dark = themeFromPixels({ background: foreground, foreground: background });
    expect(dark.cursorAccent).toBe(dark.background);
    expect(dark.cursorAccent).not.toBe(dark.cursor);
    const light = themeFromPixels({ background, foreground });
    expect(light.cursorAccent).toBe(light.background);
    expect(light.cursorAccent).not.toBe(light.cursor);
  });

  it("names no ANSI colour", () => {
    expect(Object.keys(themeFromPixels({ background, foreground }))).not.toContain("red");
  });
});

describe("mixHex", () => {
  const white: Pixel = [255, 255, 255, 255];
  const black: Pixel = [0, 0, 0, 255];

  it("writes the base at 0, the top at 1 and the blend between as #rrggbb", () => {
    expect(mixHex(white, black, 0)).toBe("#ffffff");
    expect(mixHex(white, black, 1)).toBe("#000000");
    expect(mixHex(white, black, 0.5)).toBe("#808080");
  });

  it("lets a translucent top show only as much as its alpha", () => {
    expect(mixHex(black, [255, 255, 255, 51], 1)).toBe("#333333");
  });
});

describe("searchDecorationsFromPixels", () => {
  const background: Pixel = [255, 255, 255, 255];
  const foreground: Pixel = [24, 24, 27, 255];

  it("tints matches with the foreground and marks the current one harder", () => {
    expect(searchDecorationsFromPixels({ background, foreground })).toEqual({
      matchBackground: "#dcdcdd",
      matchOverviewRuler: "#dcdcdd",
      activeMatchBackground: "#aeaeaf",
      activeMatchBorder: "#18181b",
      activeMatchColorOverviewRuler: "#18181b",
    });
  });

  it("is null when a token could not be resolved", () => {
    expect(searchDecorationsFromPixels({ background, foreground: null })).toBeNull();
    expect(searchDecorationsFromPixels({ background: null, foreground })).toBeNull();
  });
});
