import fixture from "@poseidon/contracts/fixtures/thread-detail-snapshot.json";
import { describe, expect, it } from "vitest";

import { diffStats, hasHunkHeader } from "./diff-stats";

describe("diffStats", () => {
  it("counts +/- lines and skips file headers", () => {
    const diff = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old line",
      "+new line",
      "+another",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("returns zeros for empty input", () => {
    expect(diffStats("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("hasHunkHeader", () => {
  it("accepts the ranged forms the parser understands", () => {
    expect(hasHunkHeader("--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n+new")).toBe(true);
    expect(hasHunkHeader("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+new")).toBe(true);
  });

  it("rejects a bare @@ marker, which renders as an empty box", () => {
    expect(hasHunkHeader("--- /dev/null\n+++ b/x\n@@\n+new")).toBe(false);
    expect(hasHunkHeader("")).toBe(false);
  });

  it("holds for every diff the thread fixture ships", () => {
    const diffs = fixture.items
      .map((item) => ("fileChange" in item ? item.fileChange?.diff : undefined))
      .filter((diff): diff is string => diff !== undefined);
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) {
      expect(hasHunkHeader(diff)).toBe(true);
    }
  });
});
