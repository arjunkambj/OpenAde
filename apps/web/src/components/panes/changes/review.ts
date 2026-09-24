/**
 * How the Changes pane reads a review, with no React in the way.
 *
 * The list is an overview first: every file starts as one closed row, and the
 * user opens what they want to read. What they open or close is kept per
 * thread and per path (`ChangesReview` in `@/state/ui`), so it outlives the
 * comparison it was made in. These are the rules over that record; the pane
 * only renders them.
 */

import type { GitDiffFile } from "@OpenAde/contracts/rpc";

import type { ChangesReview } from "@/state/ui";

/**
 * Past this many changed lines even a lone file starts closed. Every open file
 * hands its patch to the two-worker highlight pool at once, and a working-tree
 * diff against HEAD can be hundreds of files and megabytes of patch text — so
 * nothing opens on its own except a comparison of one file small enough to
 * read at a glance, where a closed row would only cost a click.
 */
export const OPEN_LINES_LIMIT = 400;

/** Whether a comparison's files start open: only a lone file of at most `OPEN_LINES_LIMIT` lines. */
export const startsOpen = (
  files: ReadonlyArray<Pick<GitDiffFile, "additions" | "deletions">>,
): boolean => files.length === 1 && files[0]!.additions + files[0]!.deletions <= OPEN_LINES_LIMIT;

/** Whether `path` is open: the user's own choice for it, else the list's default. */
export const isOpen = (review: ChangesReview, path: string, byDefault: boolean): boolean =>
  review.open[path] ?? byDefault;

/** The review with every path in `paths` opened or closed, as if each were clicked. */
export const withOpen = (
  review: ChangesReview,
  paths: ReadonlyArray<string>,
  open: boolean,
): ChangesReview => {
  const next = { ...review.open };
  for (const path of paths) {
    next[path] = open;
  }
  return { ...review, open: next };
};

/**
 * Whether the summary line's toggle collapses: every file that has a patch to
 * show is open. Anything less and it expands, so one click always opens the
 * lot — the same way a mixed selection's checkbox checks everything first.
 */
export const everyFileOpen = (
  review: ChangesReview,
  files: ReadonlyArray<Pick<GitDiffFile, "path" | "diff">>,
  byDefault: boolean,
): boolean => {
  const expandable = files.filter((file) => file.diff !== "");
  return expandable.length > 0 && expandable.every((file) => isOpen(review, file.path, byDefault));
};
