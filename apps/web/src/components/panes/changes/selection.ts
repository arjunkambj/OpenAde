/**
 * What the changes pane's selection means, with no React in the way.
 *
 * The pane has three scopes (`ChangesScope`):
 *
 * - **This turn** — the turn selector's two selects. Their values are git
 *   refs, plus two sentinels for the ends the `git.diff` payload leaves out:
 *   `HEAD` as the base (the server's own default) and the working tree as the
 *   target (an omitted `to`).
 * - **Branch vs base** — the working tree against the point where the branch
 *   forked from its base (`mergeBase`), so it shows the branch's commits plus
 *   whatever is not committed yet.
 * - **Uncommitted** — the working tree against `HEAD`: both ends omitted.
 *
 * `diffRangeFor` is the single place that translates a selection into the RPC
 * payload, so every scope is one code path.
 */

import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { GitDiffRange } from "@OpenAde/client-runtime/gitAtoms";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import type { ChangesScope } from "@/state/ui";

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

/** What one scope compares; only "This turn" carries the turn selector's refs. */
export type ChangesSelection =
  | {
      readonly scope: Extract<ChangesScope, "turn">;
      readonly base: string;
      readonly target: string;
    }
  | { readonly scope: Extract<ChangesScope, "branch">; readonly mergeBase: string | null }
  | { readonly scope: Extract<ChangesScope, "uncommitted"> };

/**
 * The `git.diff` payload for one selection, or `null` for "Branch vs base"
 * with no base to compare with. Sentinels become omitted ends, and the thread
 * picks the directory — its worktree, when it has one.
 */
export const diffRangeFor = (
  where: { readonly projectId: ProjectId; readonly threadId: ThreadId },
  selection: ChangesSelection,
): GitDiffRange | null => {
  const scope = { projectId: where.projectId, threadId: where.threadId };
  switch (selection.scope) {
    case "turn":
      return {
        ...scope,
        ...(selection.base === HEAD_VALUE ? {} : { from: selection.base }),
        ...(selection.target === WORKTREE_VALUE ? {} : { to: selection.target }),
      };
    case "branch":
      return selection.mergeBase === null ? null : { ...scope, mergeBase: selection.mergeBase };
    case "uncommitted":
      return scope;
  }
};

/**
 * The branch "Branch vs base" compares with: the worktree's own base when the
 * thread was started in one — it records what it was cut from — else the
 * repository's default branch. `undefined` while the branch list has not
 * answered, `null` when there is nothing to compare with.
 */
export const branchBaseFor = (
  worktreeBase: string | undefined,
  defaultBranch: string | null | undefined,
): string | null | undefined => worktreeBase ?? defaultBranch;

/**
 * A stable key for one comparison, for the file rows' disclosure ids: the same
 * file in another comparison is a different patch, so it opens on its own.
 */
export const rangeKeyOf = (range: GitDiffRange): string =>
  range.mergeBase === undefined
    ? `${range.from ?? "HEAD"}:${range.to ?? "worktree"}`
    : `${range.mergeBase}...`;
