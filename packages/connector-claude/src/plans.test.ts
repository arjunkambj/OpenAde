/**
 * The plan an ExitPlanMode call carries, where the CLI keeps its plan files,
 * and which writes are the model writing its plan.
 */

import { describe, expect, it } from "vitest";

import { isPlanFileWrite, planOf, plansDirFor } from "./plans";

const PLANS = "/home/u/.claude/plans";

describe("planOf", () => {
  it("reads the plan and its file from the input the CLI filled in", () => {
    expect(planOf({ plan: "  # Plan\n\n1. Add it  ", planFilePath: `${PLANS}/a.md` })).toEqual({
      markdown: "# Plan\n\n1. Add it",
      path: `${PLANS}/a.md`,
    });
    expect(planOf({ plan: "# Plan" })).toEqual({ markdown: "# Plan" });
  });

  it("finds no plan in an input without one", () => {
    expect(planOf({})).toBeUndefined();
    expect(planOf({ plan: "   " })).toBeUndefined();
    expect(planOf({ plan: null, planFilePath: `${PLANS}/a.md` })).toBeUndefined();
    expect(planOf(undefined)).toBeUndefined();
  });
});

describe("plansDirFor", () => {
  it("is under the instance's own config dir, or ~/.claude", () => {
    expect(plansDirFor({ CLAUDE_CONFIG_DIR: "/acct/claude" }, "/home/u")).toBe(
      "/acct/claude/plans",
    );
    expect(plansDirFor({ HOME: "/home/v" }, "/home/u")).toBe("/home/v/.claude/plans");
    expect(plansDirFor({}, "/home/u")).toBe(PLANS);
  });
});

describe("isPlanFileWrite", () => {
  it.each([
    ["Write", `${PLANS}/tidy-fox.md`, true],
    ["Edit", `${PLANS}/tidy-fox.md`, true],
    ["MultiEdit", `${PLANS}/tidy-fox.md`, true],
    ["Write", `${PLANS}/tidy-fox.txt`, false],
    ["Write", `${PLANS}/nested/tidy-fox.md`, false],
    ["Write", `${PLANS}/../settings.md`, false],
    ["Write", `${PLANS}/.md`, false],
    ["Write", "plans/tidy-fox.md", false],
    ["Write", "/repo/plans/tidy-fox.md", false],
    ["Bash", `${PLANS}/tidy-fox.md`, false],
    ["NotebookEdit", `${PLANS}/tidy-fox.md`, false],
  ] as const)("%s on %s → %s", (tool, path, expected) => {
    expect(isPlanFileWrite(tool, { file_path: path }, PLANS)).toBe(expected);
  });

  it("is false with no path", () => {
    expect(isPlanFileWrite("Write", {}, PLANS)).toBe(false);
    expect(isPlanFileWrite("Write", undefined, PLANS)).toBe(false);
  });
});
