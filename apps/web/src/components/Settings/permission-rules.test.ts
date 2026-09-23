import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { PermissionRule } from "@OpenAde/contracts/settings";
import { describe, expect, it } from "vitest";

import { groupRules, ruleKey, withPattern, withoutRule } from "./permission-rules";

const rule = (
  pattern: string,
  scope: PermissionRule["scope"] = "global",
  owner?: string,
  decision: PermissionRule["decision"] = "allow",
): PermissionRule => ({
  scope,
  ...(scope === "project" && owner !== undefined ? { projectId: owner as ProjectId } : {}),
  ...(scope === "session" && owner !== undefined ? { threadId: owner as ThreadId } : {}),
  pattern,
  decision,
  createdAt: "2026-09-01T00:00:00.000Z",
});

const projects = [
  { projectId: "p1", name: "First" },
  { projectId: "p2", name: "Second" },
];

const threads = [{ threadId: "t1", title: "Fix the build" }];

const shape = (groups: ReturnType<typeof groupRules>) =>
  groups.map((group) => [group.scope, group.title, group.rules.map((r) => r.pattern)]);

describe("ruleKey", () => {
  it("tells apart rules that differ only by scope or owner", () => {
    const keys = new Set([
      ruleKey(rule("Shell(ls)")),
      ruleKey(rule("Shell(ls)", "project", "p1")),
      ruleKey(rule("Shell(ls)", "project", "p2")),
      ruleKey(rule("Shell(ls)", "session", "t1")),
    ]);
    expect(keys.size).toBe(4);
  });

  it("ignores the decision and creation time", () => {
    expect(ruleKey(rule("Shell(ls)", "global", undefined, "deny"))).toBe(
      ruleKey(rule("Shell(ls)")),
    );
  });
});

describe("groupRules", () => {
  it("orders global, projects in project order, removed project, then threads", () => {
    const rules = [
      rule("Shell(t)", "session", "t1"),
      rule("Shell(gone)", "project", "p9"),
      rule("Shell(b)", "project", "p2"),
      rule("Shell(a)", "project", "p1"),
      rule("Shell(g)"),
      rule("Shell(x)", "session", "t9"),
    ];
    expect(shape(groupRules(rules, projects, threads))).toEqual([
      ["global", "All projects", ["Shell(g)"]],
      ["project", "First", ["Shell(a)"]],
      ["project", "Second", ["Shell(b)"]],
      ["project", "Removed project", ["Shell(gone)"]],
      ["session", "Fix the build", ["Shell(t)"]],
      ["session", "Deleted thread", ["Shell(x)"]],
    ]);
  });

  it("keeps the order rules arrived in within a group", () => {
    const rules = [
      rule("Shell(2)", "project", "p1"),
      rule("Shell(1)", "project", "p1"),
      rule("Shell(3)", "project", "p1"),
    ];
    expect(shape(groupRules(rules, projects, threads))).toEqual([
      ["project", "First", ["Shell(2)", "Shell(1)", "Shell(3)"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(groupRules([], projects, threads)).toEqual([]);
    expect(shape(groupRules([rule("Shell(a)", "project", "p2")], projects, threads))).toEqual([
      ["project", "Second", ["Shell(a)"]],
    ]);
  });

  it("gives every group a distinct key", () => {
    const rules = [
      rule("Shell(g)"),
      rule("Shell(a)", "project", "p1"),
      rule("Shell(gone)", "project", "p9"),
      rule("Shell(t)", "session", "t1"),
      rule("Shell(x)", "session", "t9"),
    ];
    const keys = groupRules(rules, projects, threads).map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("withoutRule", () => {
  it("removes only the matching rule, even when another scope has the same pattern", () => {
    const rules = [
      rule("Shell(ls)"),
      rule("Shell(ls)", "project", "p1"),
      rule("Shell(ls)", "session", "t1"),
    ];
    expect(withoutRule(rules, rule("Shell(ls)", "project", "p1"))).toEqual([rules[0], rules[2]]);
  });

  it("leaves the list alone when the rule is already gone", () => {
    const rules = [rule("Shell(ls)")];
    expect(withoutRule(rules, rule("Shell(pwd)"))).toEqual(rules);
  });
});

describe("withPattern", () => {
  const rules = [
    rule("Shell(ls)", "project", "p1", "deny"),
    rule("Shell(pwd)", "project", "p1"),
    rule("Shell(cat *)"),
  ];
  const target = rules[0]!;

  it("refuses a pattern that does not parse", () => {
    expect(withPattern(rules, target, "Nope(x)")).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a whitespace-only pattern", () => {
    expect(withPattern(rules, target, "   ")).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses the current pattern, trimmed", () => {
    expect(withPattern(rules, target, "  Shell(ls) ")).toEqual({ ok: false, reason: "unchanged" });
  });

  it("refuses a pattern another rule of the same scope and project has", () => {
    expect(withPattern(rules, target, "Shell(pwd)")).toEqual({ ok: false, reason: "duplicate" });
  });

  it("allows a pattern another scope or project already has", () => {
    expect(withPattern(rules, target, "Shell(cat *)").ok).toBe(true);
    const other = [...rules, rule("Shell(rm *)", "project", "p2")];
    expect(withPattern(other, target, "Shell(rm *)").ok).toBe(true);
  });

  it("replaces only the pattern, keeping decision, scope and creation time", () => {
    const edit = withPattern(rules, target, " Shell(ls -la) ");
    expect(edit).toEqual({
      ok: true,
      rules: [{ ...target, pattern: "Shell(ls -la)" }, rules[1], rules[2]],
    });
  });
});
