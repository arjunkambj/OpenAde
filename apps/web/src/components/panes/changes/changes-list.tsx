/**
 * The Changes pane's file list for one comparison.
 *
 * The diff is the file list, because `GitDiff.files` already carries the path,
 * the `+`/`-` counts and the per-file patch. Each patch renders through
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
import { DisclosureRow } from "@/components/timeline/row-shell";
import { useRowDisclosure, type DiffStyle } from "@/state/ui";

import { useGitAtoms } from "./git-atoms";
import { rangeKeyOf } from "./selection";
import {
  type HoneyIcon,
  AlertTriangle,
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

function FileRow({
  file,
  rangeKey,
  diffStyle,
}: {
  file: GitDiffFile;
  rangeKey: string;
  diffStyle: DiffStyle;
}) {
  const rowId = `changes-${rangeKey}-${file.path}`;
  // `DisclosureRow` keeps its content mounted, so mounting every `InlineDiff`
  // up front would hand the whole patch set to the two-worker highlight pool
  // the moment the list renders — and a working-tree diff against HEAD can be
  // hundreds of files and megabytes of patch text. Read the same disclosure
  // state the row uses and render a placeholder until it is opened;
  // non-undefined, so the row still counts as expandable.
  const [open] = useRowDisclosure(rowId);
  return (
    <DisclosureRow
      rowId={rowId}
      icon={KIND_ICON[file.kind]}
      label={
        <span className="font-mono text-xs">
          {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
      }
      meta={
        file.additions > 0 || file.deletions > 0 ? (
          <span className="ml-1 inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
            {file.additions > 0 ? <span className="text-added">+{file.additions}</span> : null}
            {file.deletions > 0 ? <span className="text-removed">−{file.deletions}</span> : null}
          </span>
        ) : null
      }
    >
      {file.diff === "" ? undefined : open ? (
        <InlineDiff patch={file.diff} diffStyle={diffStyle} />
      ) : (
        <div />
      )}
    </DisclosureRow>
  );
}

/** The files of one comparison, read from its own `git.diff` atom. */
export function ChangesList({
  range,
  status,
  connected,
  diffStyle,
  onRetry,
}: {
  range: GitDiffRange;
  status: PaneQuery<GitStatus> | null;
  connected: boolean;
  diffStyle: DiffStyle;
  onRetry: () => void;
}) {
  const { gitDiffAtom } = useGitAtoms();
  const diff = queryValue<GitDiff>(useAtomValue(gitDiffAtom(range)));
  const rangeKey = rangeKeyOf(range);

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
    <div className="flex flex-col gap-1 p-2">
      {diff.value.files.map((file) => (
        <FileRow key={file.path} file={file} rangeKey={rangeKey} diffStyle={diffStyle} />
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
