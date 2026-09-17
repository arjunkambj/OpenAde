/**
 * The changes pane's selection rules: which comparison each pair of select
 * values asks the server for, and what happens when the selected checkpoint is
 * gone.
 */

import { describe, expect, it } from "vitest";
import { makeCheckpointId, makeProjectId, makeTurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import { HEAD_VALUE, WORKTREE_VALUE, checkpointLabel, diffRangeFor, resolveRef } from "./selection";

const checkpoint = (ref: string, createdAt = "2026-01-01T09:30:00.000Z"): CheckpointSummary => ({
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref,
  createdAt,
});

describe("changes pane selection", () => {
  it("maps the three comparisons onto the git.diff payload", () => {
    const projectId = makeProjectId();
    const a = "refs/openade/checkpoints/t/1";
    const b = "refs/openade/checkpoints/t/2";

    // Working tree against HEAD — both ends omitted, the server's default.
    expect(diffRangeFor(projectId, HEAD_VALUE, WORKTREE_VALUE)).toEqual({ projectId });
    // One turn's changes: the checkpoint is the base, the worktree the target.
    expect(diffRangeFor(projectId, a, WORKTREE_VALUE)).toEqual({ projectId, from: a });
    // Turn to turn.
    expect(diffRangeFor(projectId, a, b)).toEqual({ projectId, from: a, to: b });
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
