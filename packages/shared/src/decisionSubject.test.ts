import { describe, expect, it } from "vitest";

import { approvalSubject, planSubject, questionSubject } from "./decisionSubject";

describe("approvalSubject", () => {
  it("prefers the command, then the path-like keys, then url and query", () => {
    expect(
      approvalSubject({ toolName: "shell_command", input: { command: "pnpm test", path: "x" } }),
    ).toBe("pnpm test");
    expect(approvalSubject({ toolName: "write_file", input: { file_path: "src/a.ts" } })).toBe(
      "src/a.ts",
    );
    expect(approvalSubject({ toolName: "edit", input: { filePath: "src/b.ts" } })).toBe("src/b.ts");
    expect(approvalSubject({ toolName: "fetch", input: { url: "https://example.com" } })).toBe(
      "https://example.com",
    );
    expect(approvalSubject({ toolName: "web_search", input: { query: "health checks" } })).toBe(
      "health checks",
    );
  });

  it("keeps the first line of a multi-line target", () => {
    expect(
      approvalSubject({ toolName: "shell_command", input: { command: "cat <<EOF\nhello\nEOF" } }),
    ).toBe("cat <<EOF");
  });

  it("falls back to the tool name when the input names no target", () => {
    expect(approvalSubject({ toolName: "mcp__browser__snapshot", input: { ref: "@e1" } })).toBe(
      "mcp__browser__snapshot",
    );
    expect(approvalSubject({ toolName: "shell_command", input: { command: "  " } })).toBe(
      "shell_command",
    );
    expect(approvalSubject({ toolName: "other", input: null })).toBe("other");
  });
});

describe("questionSubject", () => {
  it("uses the first question's header, else its text", () => {
    expect(
      questionSubject([
        { question: "Which database?", header: "Database" },
        { question: "Which port?" },
      ]),
    ).toBe("Database");
    expect(questionSubject([{ question: "Which database?", header: "" }])).toBe("Which database?");
    expect(questionSubject([])).toBeUndefined();
  });
});

describe("planSubject", () => {
  it("names the plan file", () => {
    expect(planSubject("/Users/dev/projects/openade/plans/health-check.md")).toBe(
      "health-check.md",
    );
    expect(planSubject("C:\\plans\\ready.md")).toBe("ready.md");
    expect(planSubject("plan.md")).toBe("plan.md");
    expect(planSubject(undefined)).toBeUndefined();
  });
});
