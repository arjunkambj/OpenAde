import { makeCheckpointId, makeItemId, makeTurnId, type TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  availableCheckpoints,
  checkpointBefore,
  restoreBlockedReason,
  skipsTurns,
  turnEndTimes,
  turnOrder,
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

describe("checkpointBefore", () => {
  const order = [t1, t2, t3, t4];
  const [c1, c2, c3] = [checkpointOf(t1), checkpointOf(t2), checkpointOf(t3)];

  it("has nothing before the first turn", () => {
    expect(checkpointBefore(t1, order, [c1, c2, c3])).toBeNull();
  });

  it("takes the previous turn's checkpoint, the workspace after it", () => {
    expect(checkpointBefore(t2, order, [c1, c2, c3])).toBe(c1);
    expect(checkpointBefore(t3, order, [c1, c2, c3])).toBe(c2);
    expect(checkpointBefore(t4, order, [c1, c2, c3])).toBe(c3);
  });

  it("never takes the message's own turn or a later one", () => {
    expect(checkpointBefore(t2, order, [c2, c3])).toBeNull();
  });

  it("falls back to an earlier checkpoint when the one right before is missing", () => {
    expect(checkpointBefore(t3, order, [c1, c3])).toBe(c1);
    expect(skipsTurns(t3, order, c1)).toBe(true);
    expect(skipsTurns(t3, order, c2)).toBe(false);
  });

  it("gives a steered message the same answer as the message that opened its turn", () => {
    const items = [
      item(t1, "user_message"),
      item(t2, "user_message"),
      item(t2),
      item(t2, "user_message"),
    ];
    const steeredOrder = turnOrder(items);
    expect(checkpointBefore(items[3]?.turnId, steeredOrder, [c1])).toBe(c1);
    expect(checkpointBefore(items[1]?.turnId, steeredOrder, [c1])).toBe(c1);
  });

  it("has none for a message outside a turn, an unknown turn, or a thread without checkpoints", () => {
    expect(checkpointBefore(undefined, order, [c1])).toBeNull();
    expect(checkpointBefore(makeTurnId(), order, [c1])).toBeNull();
    expect(checkpointBefore(t3, order, [])).toBeNull();
  });

  it("ignores a checkpoint whose turn the items do not name", () => {
    expect(checkpointBefore(t2, order, [checkpointOf(makeTurnId())])).toBeNull();
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
