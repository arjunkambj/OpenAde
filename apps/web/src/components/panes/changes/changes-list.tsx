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
 */

import { useAtomValue } from "@effect/atom-react";
import { isRepoless, type GitDiffRange, type GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitDiff, GitDiffFile, GitStatus } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import { PaneMessage } from "@/components/panes/files/pane-message";
import { InlineDiff } from "@/components/timeline/diff-pool";
import { cn } from "@/lib/utils";
import { useChangesReview, type DiffStyle } from "@/state/ui";

import { useGitAtoms } from "./git-atoms";
import { isOpen, startsOpen, withOpen } from "./review";
import {
  type HoneyIcon,
  AlertTriangle,
  ChevronRight,
  Edit,
  FileAdd,
  FileRemove,
  GitDiff as GitDiffIcon,
  Repeat,
  Spinner,
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

const KIND_ICON: Record<GitDiffFile["kind"], HoneyIcon> = {
  create: FileAdd,
  edit: Edit,
  delete: FileRemove,
};

/** `+12 −3`, each side only when it is not zero. */
function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      {additions > 0 ? <span className="text-added">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-removed">−{deletions}</span> : null}
    </span>
  );
}

/** A path as a muted directory and a bright file name, the name never cut. */
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 font-mono text-xs" title={path}>
      {slash === -1 ? null : (
        <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, slash + 1)}</span>
      )}
      <span className="shrink-0 text-foreground">{path.slice(slash + 1)}</span>
    </span>
  );
}

/**
 * One file of the stack: a header that sticks to the top while its patch
 * scrolls under it, and the patch. A closed file keeps nothing mounted.
 */
function FileSection({
  file,
  open,
  onOpenChange,
  diffStyle,
}: {
  file: GitDiffFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diffStyle: DiffStyle;
}) {
  const Glyph = KIND_ICON[file.kind];
  const expandable = file.diff !== "";
  return (
    <section>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => onOpenChange(!open)}
        className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border bg-sidebar px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:bg-hover"
      >
        <ChevronRight
          variant="bold"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
            open && expandable && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
        {file.oldPath === undefined ? (
          <FilePath path={file.path} />
        ) : (
          <span className="flex min-w-0 flex-1 gap-1 font-mono text-xs">
            <span className="min-w-0 truncate text-muted-foreground">{file.oldPath} →</span>
            <FilePath path={file.path} />
          </span>
        )}
        <LineCounts additions={file.additions} deletions={file.deletions} />
      </button>
      {open && expandable ? (
        <div className="border-b border-border">
          <InlineDiff patch={file.diff} diffStyle={diffStyle} className="rounded-none" />
        </div>
      ) : null}
    </section>
  );
}

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

/** A comparison's files once its diff has answered, with the thread's review over them. */
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
  return (
    <div className="flex flex-col border-t border-border">
      {files.map((file) => (
        <FileSection
          key={file.path}
          file={file}
          open={isOpen(review, file.path, byDefault)}
          onOpenChange={(open) => updateReview((current) => withOpen(current, [file.path], open))}
          diffStyle={diffStyle}
        />
      ))}
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

/** The comparison's summed `+`/`−`, read off the same `git.diff` atom as the list. */
export function DiffTotals({ range }: { range: GitDiffRange }) {
  const { gitDiffAtom } = useGitAtoms();
  const diff = queryValue<GitDiff>(useAtomValue(gitDiffAtom(range)));
  if (diff?._tag !== "ok") {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of diff.value.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return <LineCounts additions={additions} deletions={deletions} />;
}
