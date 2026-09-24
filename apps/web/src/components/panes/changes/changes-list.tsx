/**
 * The Changes pane's file list for one comparison.
 *
 * The diff is the file list, because `GitDiff.files` already carries the path,
 * the `+`/`-` counts and the per-file patch. It reads as an overview first:
 * one compact row per file — its kind, directory and name, and counts — with
 * every patch closed until the user opens it (`startsOpen` in `./review` has
 * the one exception). An open file's patch scrolls under its sticky header, so
 * the pane still reads top to bottom like one review. Which files are open is
 * the thread's own and kept per path (`useChangesReview`), so a new turn or
 * another comparison does not open them all again. Each patch renders through
 * `InlineDiff`, so highlighting stays on the shared worker pool and the dock
 * never blocks the main thread.
 *
 * One line above the files sums the comparison up — how many files, how many
 * lines, how many the user has viewed — with the toggle that opens or closes
 * them all at once.
 */

import { useAtomValue } from "@effect/atom-react";
import { isRepoless, type GitDiffRange, type GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitDiff, GitDiffFile, GitStatus } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { AsyncResult } from "effect/unstable/reactivity";

import { PaneMessage } from "@/components/panes/files/pane-message";
import { useChangesReview, type DiffStyle } from "@/state/ui";

import { FileSection, LineCounts } from "./file-section";
import { useGitAtoms } from "./git-atoms";
import { everyFileOpen, isOpen, startsOpen, withOpen } from "./review";
import {
  AlertTriangle,
  GitDiff as GitDiffIcon,
  Repeat,
  Spinner,
  UnfoldLess,
  UnfoldMore,
  WifiOff,
} from "@honeyicons/react";

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
  onRetry,
}: {
  threadId: string;
  range: GitDiffRange;
  status: PaneQuery<GitStatus> | null;
  connected: boolean;
  diffStyle: DiffStyle;
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
  return <ReviewList threadId={threadId} files={diff.value.files} diffStyle={diffStyle} />;
}

/**
 * The line over the files: `3 files · +20 −4`, and the toggle that opens every
 * file or closes them all.
 */
function ReviewSummary({
  files,
  allOpen,
  onAllOpenChange,
}: {
  files: ReadonlyArray<GitDiffFile>;
  allOpen: boolean;
  onAllOpenChange: (open: boolean) => void;
}) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const label = allOpen ? "Collapse all files" : "Expand all files";
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border pr-2 pl-3 type-micro text-muted-foreground">
      <span className="shrink-0">
        {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      {additions > 0 || deletions > 0 ? (
        <>
          <span aria-hidden>·</span>
          <LineCounts additions={additions} deletions={deletions} />
        </>
      ) : null}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              disabled={!allOpen && files.every((file) => file.diff === "")}
              onClick={() => onAllOpenChange(!allOpen)}
            />
          }
        >
          {allOpen ? <UnfoldLess variant="bold" /> : <UnfoldMore variant="bold" />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * A comparison's files once its diff has answered, with the thread's review
 * over them. The summary stays put and the files scroll under it.
 */
function ReviewList({
  threadId,
  files,
  diffStyle,
}: {
  threadId: string;
  files: ReadonlyArray<GitDiffFile>;
  diffStyle: DiffStyle;
}) {
  const [review, updateReview] = useChangesReview(threadId);
  const byDefault = startsOpen(files);
  const setOpen = (paths: ReadonlyArray<string>, open: boolean) =>
    updateReview((current) => withOpen(current, paths, open));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewSummary
        files={files}
        allOpen={everyFileOpen(review, files, byDefault)}
        onAllOpenChange={(open) =>
          setOpen(
            files.filter((file) => file.diff !== "").map((file) => file.path),
            open,
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-border">
        {files.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            open={isOpen(review, file.path, byDefault)}
            onOpenChange={(open) => setOpen([file.path], open)}
            diffStyle={diffStyle}
          />
        ))}
      </div>
    </div>
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
