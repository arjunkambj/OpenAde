import { describe, expect, it } from "vitest";

import { toolTarget } from "./tool-target";

describe("toolTarget", () => {
  it("takes the first known key that holds a string", () => {
    expect(toolTarget({ file_path: "src/app.ts", pattern: "foo" })).toBe("src/app.ts");
    expect(toolTarget({ pattern: "TODO", path: "src" })).toBe("src");
    expect(toolTarget({ query: "effect schema" })).toBe("effect schema");
  });

  it("skips empty and non-string values", () => {
    expect(toolTarget({ file_path: "  ", path: 3, command: "ls -la" })).toBe("ls -la");
  });

  it("keeps the first line only", () => {
    expect(toolTarget({ command: "git add .\ngit commit" })).toBe("git add .");
  });

  it("cuts a long target with an ellipsis", () => {
    const target = toolTarget({ url: `https://example.com/${"a".repeat(80)}` });
    expect(target).toHaveLength(61);
    expect(target?.endsWith("…")).toBe(true);
  });

  it("has nothing to say about inputs without a known key", () => {
    expect(toolTarget({ limit: 10 })).toBeUndefined();
    expect(toolTarget("src/app.ts")).toBeUndefined();
    expect(toolTarget(null)).toBeUndefined();
    expect(toolTarget(undefined)).toBeUndefined();
  });
});
