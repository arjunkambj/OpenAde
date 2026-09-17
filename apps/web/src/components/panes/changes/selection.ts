/**
 * What the changes pane's two selects mean, with no React in the way.
 *
 * The selected values are git refs, plus two sentinels for the ends the
 * `git.diff` payload leaves out: `HEAD` as the base (the server's own default)
 * and the working tree as the target (an omitted `to`). `diffRangeFor` is the
 * single place that translates a selection into the RPC payload, so "working
 * tree", "one turn's changes" and "turn to turn" are one code path.
 */

import type { ProjectId } from "@OpenAde/contracts/ids";
import type { GitDiffRange } from "@OpenAde/client-runtime/gitAtoms";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

/** Base sentinel: diff against the commit the worktree is sitting on. */
export const HEAD_VALUE = "__head__";
/** Target sentinel: the files on disk right now, committed or not. */
export const WORKTREE_VALUE = "__worktree__";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Checkpoints are appended in turn order, so the index is the turn number the
 * user saw in the timeline. The time disambiguates a long thread; a checkpoint
 * with an unparseable timestamp still gets a label.
 */
export const checkpointLabel = (checkpoint: CheckpointSummary, index: number): string => {
  const at = new Date(checkpoint.createdAt);
  return Number.isNaN(at.getTime())
    ? `Turn ${index + 1}`
    : `Turn ${index + 1} · ${TIME.format(at)}`;
};

/**
 * A selected ref that is no longer in the thread's checkpoint list — pruned
 * with a deleted thread, or gone after a resnapshot — falls back to the
 * sentinel instead of querying a ref git no longer has.
 */
export const resolveRef = (
  value: string,
  checkpoints: ReadonlyArray<CheckpointSummary>,
  fallback: string,
): string =>
  value === HEAD_VALUE ||
  value === WORKTREE_VALUE ||
  checkpoints.some((checkpoint) => checkpoint.ref === value)
    ? value
    : fallback;

/** The `git.diff` payload for one selection. Sentinels become omitted ends. */
export const diffRangeFor = (projectId: ProjectId, base: string, target: string): GitDiffRange => ({
  projectId,
  ...(base === HEAD_VALUE ? {} : { from: base }),
  ...(target === WORKTREE_VALUE ? {} : { to: target }),
});
