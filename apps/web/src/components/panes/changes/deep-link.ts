/**
 * Links into the Changes pane from elsewhere in the thread — the timeline's
 * turn summaries — with no React in the way.
 *
 * A link is the thread route's search: `?pane=changes&turn=<checkpoint
 * ref>&file=<path>`. `turn` picks that turn in the Compare menu and `file`
 * opens that file and scrolls it into view, once: the pane clears both as soon
 * as it has acted on them, so a reload or a back step does not scroll again.
 * A turn that never got a checkpoint links with `LATEST_TURN`, and so does a
 * ref the thread no longer has — both land on the latest turn rather than on
 * a comparison git cannot make.
 *
 * The `file` is whatever path the timeline recorded, and agents record the
 * absolute path they wrote to, while git names files relative to the
 * repository. `linkedFileIndex` bridges the two by matching the tail of the
 * link on whole path segments, so the link itself stays as the agent wrote it.
 */

import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

/** The `turn` a link carries when the turn it came from has no checkpoint. */
export const LATEST_TURN = "latest";

/** The link's own part of the thread route's search. */
export interface ChangesLink {
  readonly turn?: string | undefined;
  readonly file?: string | undefined;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The route's `validateSearch` for the link's params: anything not a non-empty string is dropped. */
export const parseChangesLink = (search: Readonly<Record<string, unknown>>): ChangesLink => ({
  turn: nonEmpty(search["turn"]),
  file: nonEmpty(search["file"]),
});

/** The link to one turn's changes, and to one file in them when `file` is given. */
export const changesLink = (checkpointRef: string | undefined, file?: string): ChangesLink => ({
  turn: checkpointRef ?? LATEST_TURN,
  ...(file === undefined ? {} : { file }),
});

/**
 * The pane's turn choice for a linked `turn`: the ref itself for an earlier
 * turn the thread still has, else `null` — following the latest turn, the way
 * picking the latest from the Compare menu does.
 */
export const linkedTurnChoice = (
  checkpoints: ReadonlyArray<CheckpointSummary>,
  turn: string,
): string | null =>
  turn !== checkpoints.at(-1)?.ref && checkpoints.some((checkpoint) => checkpoint.ref === turn)
    ? turn
    : null;

/** A path with Windows separators turned into git's forward slashes. */
const slashed = (path: string): string => path.replaceAll("\\", "/");

/**
 * Which of the comparison's `paths` a linked `file` names, or `-1` for none.
 * The same path wins outright. Otherwise the link is taken as that file under
 * some root the pane does not need to know — the thread's worktree, or the
 * repository holding the project — so a git path the link ends with, on a
 * segment boundary, is a match, and the longest such path wins: `/r/src/a.ts`
 * picks `src/a.ts` over `a.ts`.
 */
export const linkedFileIndex = (paths: ReadonlyArray<string>, file: string): number => {
  const exact = paths.indexOf(file);
  if (exact !== -1) {
    return exact;
  }
  const wanted = slashed(file);
  let best = -1;
  let bestLength = 0;
  paths.forEach((path, index) => {
    if (path.length > bestLength && wanted.endsWith(`/${path}`)) {
      best = index;
      bestLength = path.length;
    }
  });
  return best;
};
