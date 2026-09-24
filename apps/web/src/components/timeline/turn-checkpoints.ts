/**
 * Which checkpoint "Restore to here" goes back to, and whether it may.
 *
 * The server captures a checkpoint when a turn completes, so turn T's
 * checkpoint is the workspace *after* T. The workspace as it was before a
 * message was sent is therefore the checkpoint of the turn before that
 * message's turn: the latest one whose turn precedes it. The thread's first
 * turn has nothing before it, and a workspace that is not a git repository
 * has no checkpoints at all; both leave the message without a restore.
 *
 * Turn order comes from the items themselves, first seen first: every
 * `user_message` carries its `turnId` (a message steered into a running turn
 * carries that turn's), and items stay in the order they were created.
 */

import type { TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
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

/**
 * The checkpoint that holds the workspace as it was before `turnId` ran: the
 * last checkpoint of a turn that precedes it in `order`. A turn whose own
 * checkpoint is missing (pruned, or its capture failed) is skipped for an
 * earlier one, which also undoes that turn — `skipsTurns` says so. `null` for
 * the first turn, a turn the order does not know, and a thread with none.
 */
export const checkpointBefore = (
  turnId: TurnId | undefined,
  order: ReadonlyArray<TurnId>,
  checkpoints: ReadonlyArray<CheckpointSummary>,
): CheckpointSummary | null => {
  const position = turnId === undefined ? -1 : order.indexOf(turnId);
  if (position <= 0) {
    return null;
  }
  let best: CheckpointSummary | null = null;
  let bestRank = -1;
  for (const checkpoint of checkpoints) {
    const rank = order.indexOf(checkpoint.turnId);
    // `>=` so a later entry for the same turn wins, as the list is in order.
    if (rank !== -1 && rank < position && rank >= bestRank) {
      best = checkpoint;
      bestRank = rank;
    }
  }
  return best;
};

/**
 * Whether restoring `checkpoint` for a message in `turnId` also undoes turns
 * between the two — the turn right before the message has no checkpoint of
 * its own. The dialog says so rather than promise the exact state.
 */
export const skipsTurns = (
  turnId: TurnId | undefined,
  order: ReadonlyArray<TurnId>,
  checkpoint: CheckpointSummary,
): boolean => {
  const position = turnId === undefined ? -1 : order.indexOf(turnId);
  return position > 0 && order[position - 1] !== checkpoint.turnId;
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
