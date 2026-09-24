import { makeCheckpointId, makeItemId, makeTurnId, type TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointRestore, CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  availableCheckpoints,
  restoreBlockedReason,
  restorePointBefore,
  turnEndTimes,
  turnOrder,
  workspaceSettled,
} from "@/components/timeline/turn-checkpoints";

const item = (turnId: TurnId | undefined, kind: ItemSnapshot["kind"] = "tool_call") =>
  ({
    itemId: makeItemId(),
    kind,
    status: "completed",
    ...(turnId === undefined ? {} : { turnId }),
  }) as ItemSnapshot;

const checkpointOf = (turnId: TurnId): CheckpointSummary => ({
  checkpointId: makeCheckpointId(),
  turnId,
  ref: `refs/openade/checkpoints/t/${turnId}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const [t1, t2, t3, t4] = [makeTurnId(), makeTurnId(), makeTurnId(), makeTurnId()] as const;

describe("turnOrder", () => {
  it("lists each turn once, in the order it first appears, skipping rows outside a turn", () => {
    const items = [
      item(undefined, "error"),
      item(t1, "user_message"),
      item(t1),
      item(t2, "user_message"),
      item(t2),
      // A message steered into the running turn carries that turn's id.
      item(t2, "user_message"),
      item(t3, "user_message"),
    ];
    expect(turnOrder(items)).toEqual([t1, t2, t3]);
    expect(turnOrder([])).toEqual([]);
  });
});

describe("restorePointBefore", () => {
  const order = [t1, t2, t3, t4];
  const [c1, c2, c3] = [checkpointOf(t1), checkpointOf(t2), checkpointOf(t3)];
  /** The checkpoint it goes back to, or null. */
  const before = (
    turnId: TurnId | undefined,
    checkpoints: ReadonlyArray<CheckpointSummary>,
    restores: ReadonlyArray<CheckpointRestore> = [],
    turns: ReadonlyArray<TurnId> = order,
  ) => restorePointBefore(turnId, turns, checkpoints, restores)?.checkpoint ?? null;

  it("has nothing before the first turn", () => {
    expect(before(t1, [c1, c2, c3])).toBeNull();
  });

  it("takes the previous turn's checkpoint, the workspace after it", () => {
    expect(before(t2, [c1, c2, c3])).toBe(c1);
    expect(before(t3, [c1, c2, c3])).toBe(c2);
    expect(before(t4, [c1, c2, c3])).toBe(c3);
    expect(restorePointBefore(t3, order, [c1, c2, c3])?.skipsTurns).toBe(false);
  });

  it("never takes the message's own turn or a later one", () => {
    expect(before(t2, [c2, c3])).toBeNull();
  });

  it("falls back to an earlier checkpoint when the one right before is missing", () => {
    expect(restorePointBefore(t3, order, [c1, c3])).toEqual({ checkpoint: c1, skipsTurns: true });
  });

  it("starts a turn after a restore from the restored checkpoint", () => {
    // Turn 1 edits A (c1), turn 2 edits B (c2), the reader restores to c1,
    // turn 3 edits C (c3): before turn 3 the workspace held A alone, not A+B.
    const restores = [{ checkpoint: c1, afterTurnId: t2 }];
    expect(restorePointBefore(t3, order, [c1, c2, c3], restores)).toEqual({
      checkpoint: c1,
      skipsTurns: false,
    });
    // Turn 2 ran before the restore, and turn 4 after turn 3's own checkpoint.
    expect(before(t2, [c1, c2, c3], restores)).toBe(c1);
    expect(before(t4, [c1, c2, c3], restores)).toBe(c3);
  });

  it("takes the last of several restores between the same two turns", () => {
    const restores = [
      { checkpoint: c1, afterTurnId: t3 },
      { checkpoint: c2, afterTurnId: t3 },
    ];
    expect(before(t4, [c1, c2, c3], restores)).toBe(c2);
  });

  it("falls back past a turn without a checkpoint to a restore before it", () => {
    // Restored to c1 after turn 2; turn 3's capture failed.
    const restores = [{ checkpoint: c1, afterTurnId: t2 }];
    expect(restorePointBefore(t4, order, [c1, c2], restores)).toEqual({
      checkpoint: c1,
      skipsTurns: true,
    });
  });

  it("offers nothing when the checkpoint a restore went back to is gone", () => {
    // Falling back to turn 2's checkpoint would bring back what was rolled back.
    const restores = [{ checkpoint: c1, afterTurnId: t2 }];
    expect(before(t3, [c2, c3], restores)).toBeNull();
  });

  it("ignores a restore after a turn the items do not name, or before any turn", () => {
    const restores = [
      { checkpoint: c1, afterTurnId: makeTurnId() },
      { checkpoint: c1, afterTurnId: null },
    ];
    expect(before(t3, [c1, c2, c3], restores)).toBe(c2);
  });

  it("gives a steered message the same answer as the message that opened its turn", () => {
    const items = [
      item(t1, "user_message"),
      item(t2, "user_message"),
      item(t2),
      item(t2, "user_message"),
    ];
    const steeredOrder = turnOrder(items);
    expect(before(items[3]?.turnId, [c1], [], steeredOrder)).toBe(c1);
    expect(before(items[1]?.turnId, [c1], [], steeredOrder)).toBe(c1);
  });

  it("has none for a message outside a turn, an unknown turn, or a thread without checkpoints", () => {
    expect(before(undefined, [c1])).toBeNull();
    expect(before(makeTurnId(), [c1])).toBeNull();
    expect(before(t3, [])).toBeNull();
  });

  it("ignores a checkpoint whose turn the items do not name", () => {
    expect(before(t2, [checkpointOf(makeTurnId())])).toBeNull();
  });
});

describe("availableCheckpoints", () => {
  const [c1, c2, c3] = [checkpointOf(t1), checkpointOf(t2), checkpointOf(t3)];

  it("keeps the fold's checkpoints the repository still lists, in the fold's order", () => {
    expect(availableCheckpoints([c1, c2, c3], [c3, c1])).toEqual([c1, c3]);
  });

  it("drops everything when the repository lists none", () => {
    expect(availableCheckpoints([c1, c2], [])).toEqual([]);
  });

  it("falls back to the fold while the list loads or after it failed", () => {
    const fold = [c1, c2];
    expect(availableCheckpoints(fold, null)).toBe(fold);
  });

  it("returns the fold itself when nothing is missing, so memoised readers keep it", () => {
    const fold = [c1, c2];
    expect(availableCheckpoints(fold, [c2, c1, c3])).toBe(fold);
  });
});

describe("restoreBlockedReason", () => {
  const idle = { connected: true, restoring: false, turnRunning: false };

  it("allows a restore when connected and idle", () => {
    expect(restoreBlockedReason(idle)).toBeNull();
  });

  it("names the first thing in the way", () => {
    expect(restoreBlockedReason({ ...idle, connected: false, turnRunning: true })).toBe(
      "Not connected to the server.",
    );
    expect(restoreBlockedReason({ ...idle, restoring: true, turnRunning: true })).toBe(
      "A restore is already running.",
    );
    expect(restoreBlockedReason({ ...idle, turnRunning: true })).toBe(
      "A turn is running — stop it before restoring.",
    );
  });
});

describe("workspaceSettled", () => {
  const state = (turnRunning: boolean, restoring = false) => ({ turnRunning, restoring });

  it("is true when a turn or a restore settles", () => {
    expect(workspaceSettled(state(true), state(false))).toBe(true);
    expect(workspaceSettled(state(false, true), state(false, false))).toBe(true);
  });

  it("is false when one starts, or nothing settles", () => {
    expect(workspaceSettled(state(false), state(true))).toBe(false);
    expect(workspaceSettled(state(false, false), state(false, true))).toBe(false);
    expect(workspaceSettled(state(true), state(true))).toBe(false);
    expect(workspaceSettled(state(false), state(false))).toBe(false);
  });
});

describe("turnEndTimes", () => {
  const at = (turnId: TurnId, createdAt: string): CheckpointSummary => ({
    ...checkpointOf(turnId),
    createdAt,
  });

  it("reads each turn's end off its checkpoint, the first when it has several", () => {
    const ends = turnEndTimes([
      at(t1, "2026-01-01T00:00:05.000Z"),
      at(t2, "2026-01-01T00:01:00.000Z"),
      at(t1, "2026-01-01T00:02:00.000Z"),
    ]);
    expect(ends.get(t1)).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
    expect(ends.get(t2)).toBe(Date.parse("2026-01-01T00:01:00.000Z"));
    expect(ends.has(t3)).toBe(false);
  });

  it("skips a time it cannot read", () => {
    expect(turnEndTimes([at(t1, "not a date")]).size).toBe(0);
  });
});
