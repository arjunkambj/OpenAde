/** The diff layout: unified unless a caller asks for split. */

import { describe, expect, it } from "vitest";

import { inlineDiffOptions } from "./diff-options";

describe("inlineDiffOptions", () => {
  it("renders unified when no style is given, as the timeline's rows do", () => {
    expect(inlineDiffOptions("light").diffStyle).toBe("unified");
    expect(inlineDiffOptions("dark").themeType).toBe("dark");
  });

  it("passes a split style through to the renderer", () => {
    expect(inlineDiffOptions("light", "split").diffStyle).toBe("split");
    expect(inlineDiffOptions("light", "unified").diffStyle).toBe("unified");
  });
});
