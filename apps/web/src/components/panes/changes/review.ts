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

/**
 * A cheap fingerprint of one patch — FNV-1a over its text, with the length
 * beside it — for the viewed marks. It only has to notice that a file's patch
 * moved since it was marked, not resist anyone, so a 32-bit hash is plenty.
 */
export const patchHash = (patch: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${patch.length.toString(36)}.${(hash >>> 0).toString(36)}`;
};

/** Whether `path` is marked viewed for the patch it has now; a mark on an older patch has lapsed. */
export const isViewed = (review: ChangesReview, path: string, hash: string): boolean =>
  review.viewed[path] === hash;

/**
 * The review with `path` marked viewed against `hash`, or unmarked for `null`.
 * Marking also closes the file — a file read is a file done with — while
 * unmarking leaves it as it is.
 */
export const withViewed = (
  review: ChangesReview,
  path: string,
  hash: string | null,
): ChangesReview => {
  if (hash === null) {
    const viewed = { ...review.viewed };
    delete viewed[path];
    return { ...review, viewed };
  }
  return {
    open: { ...review.open, [path]: false },
    viewed: { ...review.viewed, [path]: hash },
  };
};

/** How many of `files` are viewed as they are now. */
export const viewedCount = (
  review: ChangesReview,
  files: ReadonlyArray<{ readonly path: string; readonly hash: string }>,
): number => files.filter((file) => isViewed(review, file.path, file.hash)).length;
