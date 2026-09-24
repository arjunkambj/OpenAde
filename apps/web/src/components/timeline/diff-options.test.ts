/** The diff layout, unified unless a caller asks for split, and the code blocks. */

import { describe, expect, it } from "vitest";

import { HIGHLIGHT_MAX_CHARS } from "./code-fence";
import { codeFileOptions, inlineDiffOptions } from "./diff-options";

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

describe("codeFileOptions", () => {
  it("draws no header or gutter and follows the theme", () => {
    const options = codeFileOptions("dark", false);
    expect(options.themeType).toBe("dark");
    expect(options.disableFileHeader).toBe(true);
    expect(options.disableLineNumbers).toBe(true);
    expect(options.tokenizeMaxLength).toBe(HIGHLIGHT_MAX_CHARS);
  });

  it("wraps only when asked", () => {
    expect(codeFileOptions("light", false).overflow).toBe("scroll");
    expect(codeFileOptions("light", true).overflow).toBe("wrap");
  });
});
