import { describe, expect, it } from "vitest";

import { fileChangeCandidates, fileChangeFallbackLabel } from "./file-change";

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

describe("fileChangeCandidates", () => {
  const change = { path: "src/new.ts", kind: "create" as const };

  it("asks nothing while the change runs, before a created file exists", () => {
    expect(fileChangeCandidates({ status: "in_progress", fileChange: change })).toEqual([]);
  });

  it("asks about the path once the change has finished, failed ones too", () => {
    expect(fileChangeCandidates({ status: "completed", fileChange: change })).toEqual([
      "src/new.ts",
    ]);
    expect(fileChangeCandidates({ status: "failed", fileChange: change })).toEqual(["src/new.ts"]);
  });

  it("asks nothing without a structured change", () => {
    expect(fileChangeCandidates({ status: "completed" })).toEqual([]);
  });
});
