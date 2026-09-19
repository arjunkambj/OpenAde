import { describe, expect, it } from "vitest";

import { fileChangeFallbackLabel } from "./file-change";

describe("fileChangeFallbackLabel", () => {
  it("uses the item's own text when the structured payload is missing", () => {
    // The regression: the row rendered nothing at all for this shape, while
    // the fold summary above it still counted the item.
    expect(fileChangeFallbackLabel("rewrote src/main.ts")).toBe("rewrote src/main.ts");
  });

  it("never renders a blank row", () => {
    expect(fileChangeFallbackLabel(undefined)).toBe("file change");
    expect(fileChangeFallbackLabel("")).toBe("file change");
    expect(fileChangeFallbackLabel("   ")).toBe("file change");
  });
});
