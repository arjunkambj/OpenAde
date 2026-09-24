/**
 * The changes pane's selection rules: which comparison each scope and each
 * pair of select values asks the server for, and what happens when the
 * selected checkpoint is gone.
 */

import { describe, expect, it } from "vitest";
import { makeCheckpointId, makeProjectId, makeThreadId, makeTurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import {
  HEAD_VALUE,
  WORKTREE_VALUE,
  branchBaseFor,
  checkpointLabel,
  diffRangeFor,
  rangeKeyOf,
  resolveRef,
} from "./selection";

const checkpoint = (ref: string, createdAt = "2026-01-01T09:30:00.000Z"): CheckpointSummary => ({
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref,
  createdAt,
});

describe("changes pane selection", () => {
  it("maps the turn selector's three comparisons onto the git.diff payload, in the thread's root", () => {
    // The thread rides along so the server diffs its worktree, when it has one.
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    const a = "refs/openade/checkpoints/t/1";
    const b = "refs/openade/checkpoints/t/2";
    const turn = (base: string, target: string) =>
      diffRangeFor(scope, { scope: "turn", base, target });

    // Working tree against HEAD — both ends omitted, the server's default.
    expect(turn(HEAD_VALUE, WORKTREE_VALUE)).toEqual(scope);
    // One turn's changes: the checkpoint is the base, the worktree the target.
    expect(turn(a, WORKTREE_VALUE)).toEqual({ ...scope, from: a });
    // Turn to turn.
    expect(turn(a, b)).toEqual({ ...scope, from: a, to: b });
  });

  it("asks for a merge-base diff for Branch vs base, and nothing without a base", () => {
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: "origin/main" })).toEqual({
      ...scope,
      mergeBase: "origin/main",
    });
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: null })).toBeNull();
  });

  it("diffs the working tree against HEAD for Uncommitted", () => {
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    const range = diffRangeFor(scope, { scope: "uncommitted" });
    expect(range).toEqual(scope);
    expect(range).not.toHaveProperty("from");
    expect(range).not.toHaveProperty("to");
    expect(range).not.toHaveProperty("mergeBase");
  });

  it("compares a worktree thread with its own base, else the default branch", () => {
    expect(branchBaseFor("origin/release", "main")).toBe("origin/release");
    expect(branchBaseFor(undefined, "main")).toBe("main");
    // The list has not answered yet, and a list that failed.
    expect(branchBaseFor(undefined, undefined)).toBeUndefined();
    expect(branchBaseFor(undefined, null)).toBeNull();
    // A recorded base does not wait for the list.
    expect(branchBaseFor("main", undefined)).toBe("main");
  });

  it("keys each comparison apart, so a file's disclosure is per comparison", () => {
    const scope = { projectId: makeProjectId() };
    const keys = [
      rangeKeyOf(scope),
      rangeKeyOf({ ...scope, from: "refs/a" }),
      rangeKeyOf({ ...scope, from: "refs/a", to: "refs/b" }),
      rangeKeyOf({ ...scope, mergeBase: "main" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("falls back when the selected checkpoint is no longer in the thread", () => {
    const kept = checkpoint("refs/openade/checkpoints/t/1");
    expect(resolveRef(kept.ref, [kept], HEAD_VALUE)).toBe(kept.ref);
    expect(resolveRef("refs/openade/checkpoints/t/9", [kept], HEAD_VALUE)).toBe(HEAD_VALUE);
    expect(resolveRef("refs/openade/checkpoints/t/9", [], WORKTREE_VALUE)).toBe(WORKTREE_VALUE);
    // The sentinels are never checkpoints and must survive an empty list.
    expect(resolveRef(HEAD_VALUE, [], HEAD_VALUE)).toBe(HEAD_VALUE);
    expect(resolveRef(WORKTREE_VALUE, [], WORKTREE_VALUE)).toBe(WORKTREE_VALUE);
  });

  it("labels a checkpoint by its turn number, and survives a bad timestamp", () => {
    expect(checkpointLabel(checkpoint("refs/a"), 0)).toMatch(/^Turn 1 · /);
    expect(checkpointLabel(checkpoint("refs/a", "not a date"), 2)).toBe("Turn 3");
  });
});
