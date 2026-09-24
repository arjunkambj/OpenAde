/**
 * The Changes pane's file list for one comparison.
 *
 * The diff is the file list, because `GitDiff.files` already carries the path,
 * the `+`/`-` counts and the per-file patch. It reads as an overview first:
 * one compact row per file — its kind, directory and name, and counts — with
 * every patch closed until the user opens it. An open file's patch scrolls under its sticky header, so
 * the pane still reads top to bottom like one review. Which files are open is
 * the thread's own and kept per path (`useChangesReview`), so a new turn or
 * another comparison does not open them all again. Each patch renders through
 * `InlineDiff`, so highlighting stays on the shared worker pool and the dock
 * never blocks the main thread.
 *
 * Once the diff answers, `ReviewList` renders the files with the thread's
 * review over them.
 */

import { useAtomValue } from "@effect/atom-react";
import { isRepoless, type GitDiffRange, type GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import { PaneMessage } from "@/components/panes/files/pane-message";
import type { DiffStyle } from "@/state/ui";

import { useGitAtoms } from "./git-atoms";
import { ReviewList } from "./review-list";
import { AlertTriangle, GitDiff as GitDiffIcon, Repeat, Spinner, WifiOff } from "@honeyicons/react";

/**
 * What the pane renders from one git atom.
 *
 * `GitQuery` covers the RPC's own outcomes, which the atom turns into values so
 * a bad ref does not kill the stream. `broken` is the case above that: the
 * atom's error channel, which is inhabited by defects the stream cannot catch
 * (a client that dies on every `git.*` call, for one). There is no value to
 * show and no reconnect will produce one, so it has to read as an error with a
 * retry rather than as a load that never finishes.
 */
export type PaneQuery<A> = GitQuery<A> | { readonly _tag: "broken" };

const BROKEN = { _tag: "broken" } as const;

/** The state of a git atom, or `null` while it has not answered yet. */
export const queryValue = <A,>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
): PaneQuery<A> | null =>
  AsyncResult.isSuccess(result) ? result.value : AsyncResult.isFailure(result) ? BROKEN : null;

/** The files of one comparison, read from its own `git.diff` atom. */
export function ChangesList({
  threadId,
  range,
  status,
  connected,
  diffStyle,
  reveal,
  onRevealed,
  onRetry,
}: {
  threadId: string;
  range: GitDiffRange;
  status: PaneQuery<GitStatus> | null;
  connected: boolean;
  diffStyle: DiffStyle;
  /** A file a link asked to open and scroll to once the files are in, or `null`. */
  reveal: string | null;
  onRevealed: () => void;
  onRetry: () => void;
}) {
  const { gitDiffAtom } = useGitAtoms();
  const diff = queryValue<GitDiff>(useAtomValue(gitDiffAtom(range)));

  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
      <Repeat variant="bold" />
      Try again
    </Button>
  );

  if (diff === null) {
    return connected ? (
      <PaneMessage icon={Spinner} text="Loading changes…" />
    ) : (
      <PaneMessage icon={WifiOff} text="Not connected to the server." />
    );
  }
  if (diff._tag === "error") {
    return <PaneMessage icon={AlertTriangle} text={diff.message} action={retry} />;
  }
  if (diff._tag === "broken") {
    return (
      <PaneMessage
        icon={AlertTriangle}
        text="Could not read the changes for this comparison."
        action={retry}
      />
    );
  }
  if (status?._tag === "ok" && isRepoless(status.value)) {
    return <NotARepository />;
  }
  if (diff.value.files.length === 0) {
    return <PaneMessage icon={GitDiffIcon} text="No changes in this comparison." />;
  }
  return (
    <ReviewList
      threadId={threadId}
      files={diff.value.files}
      diffStyle={diffStyle}
      reveal={reveal}
      onRevealed={onRevealed}
    />
  );
}

export function NotARepository() {
  return (
    <PaneMessage
      icon={GitDiffIcon}
      text="This workspace is not a git repository, so there is nothing to compare."
    />
  );
}
