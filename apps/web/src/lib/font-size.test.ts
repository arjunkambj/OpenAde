import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "@poseidon/contracts/settings";
import { describe, expect, it } from "vitest";

import { stepFontSizes } from "./font-size";

describe("stepFontSizes", () => {
  it("moves main and sidebar together by half a pixel", () => {
    expect(FONT_SIZE_STEP).toBe(0.5);
    expect(stepFontSizes({ main: 14, sidebar: 13 }, 1)).toEqual({ main: 14.5, sidebar: 13.5 });
    expect(stepFontSizes({ main: 14, sidebar: 13 }, -1)).toEqual({ main: 13.5, sidebar: 12.5 });
  });

  it("clamps each size to the range on its own", () => {
    expect(stepFontSizes({ main: 16, sidebar: MAX_FONT_SIZE }, 1)).toEqual({
      main: 16.5,
      sidebar: MAX_FONT_SIZE,
    });
    expect(stepFontSizes({ main: MIN_FONT_SIZE, sidebar: 12 }, -1)).toEqual({
      main: MIN_FONT_SIZE,
      sidebar: 11.5,
    });
    expect(stepFontSizes({ main: MAX_FONT_SIZE, sidebar: MAX_FONT_SIZE }, 1)).toEqual({
      main: MAX_FONT_SIZE,
      sidebar: MAX_FONT_SIZE,
    });
  });

  it("resets both sizes to the default", () => {
    expect(stepFontSizes({ main: 18.5, sidebar: 11 }, "reset")).toEqual({
      main: DEFAULT_FONT_SIZE,
      sidebar: DEFAULT_FONT_SIZE,
    });
  });
});
