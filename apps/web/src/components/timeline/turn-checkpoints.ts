/**
 * Which checkpoint "Restore to here" goes back to, and whether it may.
 *
 * The server captures a checkpoint when a turn completes, so turn T's
 * checkpoint is the workspace *after* T. The workspace as it was before a
 * message was sent is therefore the checkpoint of the turn before that
 * message's turn — unless a restore came between the two. A restore moves the
 * worktree back to an older checkpoint without recording one of its own, so
 * the thread's restore history (`CheckpointRestore`, stamped with the latest
 * turn when it went through) says where the next turn really started. The
 * thread's first turn has nothing before it, and a workspace that is not a
 * git repository has no checkpoints at all; both leave the message without a
 * restore.
 *
 * Turn order comes from the items themselves, first seen first: every
 * `user_message` carries its `turnId` (a message steered into a running turn
 * carries that turn's), and items stay in the order they were created.
 */

import type { TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointRestore, CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

/** Every turn id the items name, in the order each first appears. */
export const turnOrder = (items: ReadonlyArray<ItemSnapshot>): ReadonlyArray<TurnId> => {
  const seen = new Set<TurnId>();
  const order: TurnId[] = [];
  for (const item of items) {
    if (item.turnId !== undefined && !seen.has(item.turnId)) {
      seen.add(item.turnId);
      order.push(item.turnId);
    }
  }
  return order;
};

/** Where restoring to before a turn goes, and whether that undoes more. */
export interface RestorePoint {
  readonly checkpoint: CheckpointSummary;
  /**
   * The turn right before has no checkpoint of its own (pruned, or its capture
   * failed), so this is an earlier state and also undoes that turn. The
   * dialog says so rather than promise the exact state.
   */
  readonly skipsTurns: boolean;
}

/**
 * The checkpoint that holds the workspace as it was before `turnId` ran.
 * Walking back from the turn before it: a restore that went through after
 * that turn is where the next one started, and otherwise that turn's own
 * checkpoint is. A turn with neither is skipped for the state before it,
 * which also undoes that turn (`skipsTurns`). A restore whose checkpoint is
 * gone ends the walk with nothing: falling back past it would bring back the
 * turns the reader rolled back. `null` for the first turn, a turn the order
 * does not know, and a thread with no checkpoint to go to. `checkpoints` are
 * the ones still in the repository; `restores` are oldest first.
 */
export const restorePointBefore = (
  turnId: TurnId | undefined,
  order: ReadonlyArray<TurnId>,
  checkpoints: ReadonlyArray<CheckpointSummary>,
  restores: ReadonlyArray<CheckpointRestore> = [],
): RestorePoint | null => {
  const position = turnId === undefined ? -1 : order.indexOf(turnId);
  if (position <= 0) {
    return null;
  }
  // The last restore after each turn, and each turn's last checkpoint: the
  // lists are in order, so a later entry wins.
  const restoredAfter = new Map<TurnId, CheckpointRestore>();
  for (const restore of restores) {
    if (restore.afterTurnId !== null) {
      restoredAfter.set(restore.afterTurnId, restore);
    }
  }
  const own = new Map<TurnId, CheckpointSummary>();
  const available = new Map<string, CheckpointSummary>();
  for (const checkpoint of checkpoints) {
    own.set(checkpoint.turnId, checkpoint);
    available.set(checkpoint.checkpointId, checkpoint);
  }
  for (let before = position - 1; before >= 0; before -= 1) {
    const turn = order[before]!;
    const skipsTurns = before < position - 1;
    const restore = restoredAfter.get(turn);
    if (restore !== undefined) {
      const checkpoint = available.get(restore.checkpoint.checkpointId);
      return checkpoint === undefined ? null : { checkpoint, skipsTurns };
    }
    const checkpoint = own.get(turn);
    if (checkpoint !== undefined) {
      return { checkpoint, skipsTurns };
    }
  }
  return null;
};

/**
 * The fold's checkpoints that the repository still has. The fold records
 * every `thread.checkpoint.created`, but a ref removed outside the app (a
 * prune, a fresh clone) is gone all the same, and restoring it can only fail.
 * `listed` is `checkpoints.list`'s answer, or `null` while it loads or when
 * it failed — offline, say — and then the fold is all there is to go on.
 */
export const availableCheckpoints = (
  fold: ReadonlyArray<CheckpointSummary>,
  listed: ReadonlyArray<CheckpointSummary> | null,
): ReadonlyArray<CheckpointSummary> => {
  if (listed === null) {
    return fold;
  }
  const present = new Set(listed.map((checkpoint) => checkpoint.checkpointId));
  const kept = fold.filter((checkpoint) => present.has(checkpoint.checkpointId));
  return kept.length === fold.length ? fold : kept;
};

/**
 * Why no restore can start right now, or `null` when one can. The server
 * refuses a restore during a running turn and during another restore, and
 * offline the dispatch never resolves; saying so up front beats a button that
 * sits on "Restoring…" or comes back rejected. `turnRunning` is `turnInFlight`,
 * not `currentTurnId`: the server holds its turn from `turn.requested`, before
 * the client learns the id.
 */
export const restoreBlockedReason = (state: {
  readonly connected: boolean;
  readonly restoring: boolean;
  readonly turnRunning: boolean;
}): string | null =>
  !state.connected
    ? "Not connected to the server."
    : state.restoring
      ? "A restore is already running."
      : state.turnRunning
        ? "A turn is running — stop it before restoring."
        : null;

/**
 * Whether the workspace's files may have just moved: a turn, or a restore,
 * settled between `was` and `now`. The timeline counts these to name the
 * workspace's revision, which the file chips ask their `files.stat` under.
 */
export const workspaceSettled = (
  was: { readonly restoring: boolean; readonly turnRunning: boolean },
  now: { readonly restoring: boolean; readonly turnRunning: boolean },
): boolean => (was.turnRunning && !now.turnRunning) || (was.restoring && !now.restoring);

/**
 * When each turn ended, epoch ms, as far as the checkpoints tell: the server
 * captures a turn's checkpoint as the turn completes, so its `createdAt` is
 * the nearest record of the end a thread keeps. A turn with several takes the
 * first. Every checkpoint the fold recorded counts, a pruned one too — this
 * is a time, not something to restore.
 */
export const turnEndTimes = (
  checkpoints: ReadonlyArray<CheckpointSummary>,
): ReadonlyMap<TurnId, number> => {
  const ends = new Map<TurnId, number>();
  for (const checkpoint of checkpoints) {
    const ms = Date.parse(checkpoint.createdAt);
    const seen = ends.get(checkpoint.turnId);
    if (Number.isFinite(ms) && (seen === undefined || ms < seen)) {
      ends.set(checkpoint.turnId, ms);
    }
  }
  return ends;
};
