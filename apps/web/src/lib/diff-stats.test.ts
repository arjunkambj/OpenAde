import { describe, expect, it } from "vitest";

import { diffStats } from "./diff-stats";

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
