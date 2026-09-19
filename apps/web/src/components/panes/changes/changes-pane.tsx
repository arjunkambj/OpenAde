/**
 * The dock's Changes tab — the M4 surface over `git.status` and `git.diff`.
 *
 * A turn selector picks the comparison (working tree, one turn's checkpoint,
 * or checkpoint to checkpoint); the diff for that comparison is the file list,
 * because `GitDiff.files` already carries the path, the `+`/`-` counts and the
 * per-file patch. Each patch renders through `InlineDiff`, so highlighting
 * stays on the shared worker pool and the dock never blocks the main thread.
 *
 * `git.status` is read alongside it for the branch line and, because the server
 * answers a missing project or a non-repository root with an empty status
 * rather than an error, to tell "this is not a git repo" from "nothing changed".
 *
 * Restore lives behind `RestoreCheckpointDialog` and is disabled while a turn
 * is running — the server rejects it anyway, but a disabled button with a
 * reason beats a rejection after the fact.
 *
 * Nothing here refetches on a command receipt. The git atoms only fetch on a
 * connected epoch, and both writes that move the worktree — a restore and an
 * agent turn — finish after the command that started them: the checkpoint
 * reactor runs `hook.restore` off the durable `thread.checkpoint.restored`
 * event, and a turn touches files until it completes. So the pane watches the
 * thread snapshot instead: a restore records the sequence it was accepted at
 * and refetches once the snapshot passes it, and a turn refetches when
 * `currentTurnId` falls back to null.
 */

import * as React from "react";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ThreadDetailView } from "@OpenAde/client-runtime/clientState";
import { isRepoless, type GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { GitDiff, GitDiffFile, GitStatus } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import { InlineDiff } from "@/components/timeline/diff-pool";
import { DisclosureRow } from "@/components/timeline/row-shell";
import { turnInFlight } from "@/lib/turn";
import { useConnectionState } from "@/state/hooks";
import { useRowDisclosure } from "@/state/ui";

import { useGitAtoms } from "./git-atoms";
import { RestoreCheckpointDialog } from "./restore-dialog";
import { HEAD_VALUE, WORKTREE_VALUE, checkpointLabel, diffRangeFor, resolveRef } from "./selection";
import { TurnSelector } from "./turn-selector";
import {
  type HoneyIcon,
  AlertTriangle,
  Close,
  File as FileIcon,
  GitBranch,
  Repeat,
  Spinner,
  Trash,
} from "@honeyicons/react";

const KIND_ICON: Record<GitDiffFile["kind"], HoneyIcon> = {
  create: FileIcon,
  edit: Close,
  delete: Trash,
};

function PaneMessage({
  icon: Glyph,
  text,
  action,
}: {
  icon: HoneyIcon;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Glyph className="size-6 text-muted-foreground" />
      <p className="type-body text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

function FileRow({ file, rangeKey }: { file: GitDiffFile; rangeKey: string }) {
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
      {file.diff === "" ? undefined : open ? <InlineDiff patch={file.diff} /> : <div />}
    </DisclosureRow>
  );
}

/** The branch line: what the worktree is on, and how far it has drifted. */
function BranchLine({ status, onRefresh }: { status: GitStatus | null; onRefresh: () => void }) {
  return (
    <div className="flex h-7 items-center gap-1.5 type-micro text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{status?.branch ?? "no branch"}</span>
      {status !== null && status.ahead > 0 ? <span>↑{status.ahead}</span> : null}
      {status !== null && status.behind > 0 ? <span>↓{status.behind}</span> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh changes"
        className="ml-auto"
        onClick={onRefresh}
      >
        <Repeat className="size-3.5" />
      </Button>
    </div>
  );
}

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
type PaneQuery<A> = GitQuery<A> | { readonly _tag: "broken" };

const BROKEN = { _tag: "broken" } as const;

/** The state of a git atom, or `null` while it has not answered yet. */
const queryValue = <A,>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
): PaneQuery<A> | null =>
  AsyncResult.isSuccess(result) ? result.value : AsyncResult.isFailure(result) ? BROKEN : null;

/**
 * The tail of a restore: running, or the reason git refused the last one. The
 * failure line stays up until another restore is ordered — it is the only
 * place that message is ever shown, and it arrives long after the dialog that
 * started the restore has closed.
 */
function RestoreProgress({
  restoring,
  failure,
}: {
  restoring: CheckpointSummary | null;
  failure: { readonly message: string } | null;
}) {
  if (restoring !== null) {
    return (
      <div role="status" className="flex items-center gap-2 type-micro text-muted-foreground">
        <Spinner className="size-3.5" />
        <span className="min-w-0 truncate">Restoring the worktree…</span>
      </div>
    );
  }
  if (failure !== null) {
    return (
      <div role="alert" className="flex items-start gap-2 type-micro text-removed">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">Restore failed: {failure.message}</span>
      </div>
    );
  }
  return null;
}

export function ChangesPane({ snapshot }: { snapshot: ThreadDetailView }) {
  const atoms = useGitAtoms();
  const connection = useConnectionState();
  const checkpoints = snapshot.checkpoints;

  const [baseChoice, setBaseChoice] = React.useState(HEAD_VALUE);
  const [targetChoice, setTargetChoice] = React.useState(WORKTREE_VALUE);
  // A thread whose checkpoints were pruned must not keep querying a dead ref.
  const base = resolveRef(baseChoice, checkpoints, HEAD_VALUE);
  const target = resolveRef(targetChoice, checkpoints, WORKTREE_VALUE);

  const range = diffRangeFor(snapshot.projectId, base, target);

  const statusAtom = atoms.gitStatusAtom(snapshot.projectId);
  const diffAtom = atoms.gitDiffAtom(range);
  const status = queryValue<GitStatus>(useAtomValue(statusAtom));
  const diff = queryValue<GitDiff>(useAtomValue(diffAtom));
  const refreshStatus = useAtomRefresh(statusAtom);
  const refreshDiff = useAtomRefresh(diffAtom);
  const refresh = React.useCallback(() => {
    refreshStatus();
    refreshDiff();
  }, [refreshStatus, refreshDiff]);

  // The sequence the pane was at when a restore was accepted, or null when no
  // restore is outstanding. The `thread.checkpoint.restored` event bumps
  // `snapshotSequence`, and the reactor's git work runs off that same event, so
  // a later sequence is the earliest point worth rereading the worktree at.
  const [restoreAcceptedAt, setRestoreAcceptedAt] = React.useState<number | null>(null);
  const sequence = snapshot.snapshotSequence;
  React.useEffect(() => {
    if (restoreAcceptedAt !== null && sequence > restoreAcceptedAt) {
      setRestoreAcceptedAt(null);
      refresh();
    }
  }, [sequence, restoreAcceptedAt, refresh]);

  // A finished turn has written whatever it was going to write.
  const currentTurnId = snapshot.currentTurnId;
  const lastTurnId = React.useRef(currentTurnId);
  React.useEffect(() => {
    const previous = lastTurnId.current;
    lastTurnId.current = currentTurnId;
    if (previous !== null && currentTurnId === null) {
      refresh();
    }
  }, [currentTurnId, refresh]);

  const baseCheckpoint: CheckpointSummary | null =
    checkpoints.find((checkpoint) => checkpoint.ref === base) ?? null;
  const baseIndex = checkpoints.findIndex((checkpoint) => checkpoint.ref === base);

  // Offline the dispatch never resolves (the offline layer's client is
  // `Effect.never`), so the button would sit on "Restoring…" forever. Say why
  // instead.
  // `restoring` comes off the snapshot and is kept current between snapshots by
  // the client fold, so it survives a reload while git is still working. The
  // failure line is the fold's alone: the reason git gave is carried by the
  // `restore.failed` event and by nothing durable.
  const restoring = snapshot.restoring ?? null;
  const restoreFailure = snapshot.restoreFailure ?? null;

  const restoreDisabledReason =
    connection.status !== "connected"
      ? "Not connected to the server."
      : restoring !== null
        ? "A restore is already running."
        : checkpoints.length === 0
          ? "This thread has no checkpoints yet."
          : baseCheckpoint === null
            ? "Pick a turn under From to restore it."
            : // `turnInFlight`, not `currentTurnId`: the server rejects on its
              // own `currentTurn`, which it sets on `thread.turn.requested`,
              // while the client only fills the id on `thread.turn.started`.
              // Between the two the button would be live and the dispatch
              // would come back rejected.
              turnInFlight(snapshot)
              ? "A turn is running — stop it before restoring."
              : null;

  // `h-full` so the file list scrolls inside the pane and the selector stays
  // put; the dock's own scroller then never has anything to scroll.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 p-2">
        <BranchLine status={status?._tag === "ok" ? status.value : null} onRefresh={refresh} />
        <TurnSelector
          checkpoints={checkpoints}
          base={base}
          target={target}
          onBaseChange={setBaseChoice}
          onTargetChange={setTargetChoice}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate type-micro text-muted-foreground">
            {checkpoints.length === 0
              ? "No turn checkpoints yet"
              : `${checkpoints.length} turn checkpoint${checkpoints.length === 1 ? "" : "s"}`}
          </span>
          <RestoreCheckpointDialog
            threadId={snapshot.threadId}
            checkpoint={baseCheckpoint}
            label={
              baseCheckpoint === null ? "this turn" : checkpointLabel(baseCheckpoint, baseIndex)
            }
            disabledReason={restoreDisabledReason}
            onAccepted={() => setRestoreAcceptedAt(sequence)}
          />
        </div>
        <RestoreProgress restoring={restoring} failure={restoreFailure} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ChangesBody
          diff={diff}
          status={status}
          connected={connection.status === "connected"}
          rangeKey={`${base}:${target}`}
          onRetry={refresh}
        />
      </div>
    </div>
  );
}

function ChangesBody({
  diff,
  status,
  connected,
  rangeKey,
  onRetry,
}: {
  diff: PaneQuery<GitDiff> | null;
  status: PaneQuery<GitStatus> | null;
  connected: boolean;
  rangeKey: string;
  onRetry: () => void;
}) {
  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
      <Repeat className="size-3.5" />
      Try again
    </Button>
  );

  if (diff === null) {
    return connected ? (
      <PaneMessage icon={Spinner} text="Loading changes…" />
    ) : (
      <PaneMessage icon={Close} text="Not connected to the server." />
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
    return (
      <PaneMessage
        icon={Close}
        text="This workspace is not a git repository, so there is nothing to compare."
      />
    );
  }
  if (diff.value.files.length === 0) {
    return <PaneMessage icon={Close} text="No changes in this comparison." />;
  }
  return (
    <div className="flex flex-col gap-1 p-2">
      {diff.value.files.map((file) => (
        <FileRow key={file.path} file={file} rangeKey={rangeKey} />
      ))}
    </div>
  );
}
