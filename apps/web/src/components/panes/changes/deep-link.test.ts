/**
 * Links into the Changes pane: which params the route keeps, what a turn
 * summary links to, and which turn the pane lands on for a linked ref.
 */

import { describe, expect, it } from "vitest";
import { makeCheckpointId, makeTurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import { changesLink, LATEST_TURN, linkedTurnChoice, parseChangesLink } from "./deep-link";

const checkpoint = (ref: string): CheckpointSummary => ({
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref,
  createdAt: "2026-01-01T09:30:00.000Z",
});

describe("changes deep links", () => {
  it("keeps only non-empty strings from the search", () => {
    expect(parseChangesLink({ turn: "refs/a", file: "src/a.ts" })).toEqual({
      turn: "refs/a",
      file: "src/a.ts",
    });
    // Absent, empty and foreign-shaped params all read as not there.
    expect(parseChangesLink({})).toEqual({ turn: undefined, file: undefined });
    expect(parseChangesLink({ turn: "", file: 3 })).toEqual({ turn: undefined, file: undefined });
    expect(parseChangesLink({ turn: ["refs/a"] })).toEqual({ turn: undefined, file: undefined });
  });

  it("links a turn by its checkpoint, and a turn without one to the latest", () => {
    expect(changesLink("refs/a", "src/a.ts")).toEqual({ turn: "refs/a", file: "src/a.ts" });
    expect(changesLink("refs/a")).toEqual({ turn: "refs/a" });
    expect(changesLink(undefined, "src/a.ts")).toEqual({ turn: LATEST_TURN, file: "src/a.ts" });
  });

  it("picks an earlier linked turn, and follows the latest otherwise", () => {
    const checkpoints = [checkpoint("refs/1"), checkpoint("refs/2"), checkpoint("refs/3")];
    expect(linkedTurnChoice(checkpoints, "refs/1")).toBe("refs/1");
    // The latest turn is followed, so a turn that finishes next takes the pane.
    expect(linkedTurnChoice(checkpoints, "refs/3")).toBeNull();
    // A pruned ref, and a turn that never had a checkpoint.
    expect(linkedTurnChoice(checkpoints, "refs/9")).toBeNull();
    expect(linkedTurnChoice(checkpoints, LATEST_TURN)).toBeNull();
    expect(linkedTurnChoice([], "refs/1")).toBeNull();
  });
});
