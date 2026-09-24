/**
 * The dock's Changes tab — the M4 surface over `git.status` and `git.diff`.
 *
 * The scope bar picks what to compare (`selection.ts`): this turn's
 * checkpoints through the turn selector, the branch against its base, or the
 * uncommitted working tree. `ChangesList` renders that comparison's files.
 * Every read runs in the thread's own root — its worktree, when it has one.
 *
 * `git.status` is read alongside it for the branch line and, because the server
 * answers a missing project or a non-repository root with an empty status
 * rather than an error, to tell "this is not a git repo" from "nothing changed".
 *
 * Restore lives behind `RestoreCheckpointDialog`, only in the "This turn"
 * scope, and is disabled while a turn is running — the server rejects it
 * anyway, but a disabled button with a reason beats a rejection after the
 * fact.
 *
 * Refresh — the button, a landed restore and a finished turn
 * (`use-changes-refresh.ts`) — rereads every git read of the project, so the
 * header's branch picker and git actions follow along with the pane.
 */

import * as React from "react";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ThreadDetailView } from "@OpenAde/client-runtime/clientState";
import type { GitBranchList } from "@OpenAde/contracts/git";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { GitStatus } from "@OpenAde/contracts/rpc";

import { PaneMessage } from "@/components/panes/files/pane-message";
import { turnInFlight } from "@/lib/turn";
import { useConnectionState } from "@/state/hooks";
import { useChangesScope, useDiffStyle } from "@/state/ui";

import { BaseLine, BranchLine, RestoreProgress } from "./changes-header";
import { ChangesList, NotARepository, queryValue } from "./changes-list";
import { useGitAtoms } from "./git-atoms";
import { RestoreCheckpointDialog } from "./restore-dialog";
import { ScopeBar } from "./scope-bar";
import {
  HEAD_VALUE,
  WORKTREE_VALUE,
  branchBaseFor,
  checkpointLabel,
  diffRangeFor,
  resolveRef,
  type ChangesSelection,
} from "./selection";
import { TurnSelector } from "./turn-selector";
import { useChangesRefresh } from "./use-changes-refresh";
import { GitBranch, Spinner, WifiOff } from "@honeyicons/react";

export function ChangesPane({ snapshot }: { snapshot: ThreadDetailView }) {
  const atoms = useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connection = useConnectionState();
  const connected = connection.status === "connected";
  const checkpoints = snapshot.checkpoints;
  const [changesScope, setChangesScope] = useChangesScope();
  const [diffStyle, setDiffStyle] = useDiffStyle();

  const [baseChoice, setBaseChoice] = React.useState(HEAD_VALUE);
  const [targetChoice, setTargetChoice] = React.useState(WORKTREE_VALUE);
  // A thread whose checkpoints were pruned must not keep querying a dead ref.
  const base = resolveRef(baseChoice, checkpoints, HEAD_VALUE);
  const target = resolveRef(targetChoice, checkpoints, WORKTREE_VALUE);

  const projectId = snapshot.projectId;
  const scope = { projectId, threadId: snapshot.threadId };
  const status = queryValue<GitStatus>(useAtomValue(atoms.gitStatusAtom(scope)));
  const branches = queryValue<GitBranchList>(useAtomValue(atoms.gitBranchesAtom(scope)));
  const branchList = branches?._tag === "ok" ? branches.value : null;

  // "Branch vs base" waits for the branch list only when the thread did not
  // record its own base; a list that failed leaves nothing to compare with.
  const mergeBase = branchBaseFor(
    snapshot.worktree?.baseBranch,
    branches === null ? undefined : (branchList?.defaultBranch ?? null),
  );
  const selection: ChangesSelection =
    changesScope === "turn"
      ? { scope: "turn", base, target }
      : changesScope === "branch"
        ? { scope: "branch", mergeBase: mergeBase ?? null }
        : { scope: "uncommitted" };
  const range = diffRangeFor(scope, selection);

  const refresh = React.useCallback(
    () => atoms.refreshProject(registry, projectId),
    [atoms, registry, projectId],
  );
  const onRestoreAccepted = useChangesRefresh(snapshot, refresh);

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

  const restoreDisabledReason = !connected
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

  const body =
    range !== null ? (
      <ChangesList
        range={range}
        status={status}
        connected={connected}
        diffStyle={diffStyle}
        onRetry={refresh}
      />
    ) : branchList?.isRepository === false ? (
      <NotARepository />
    ) : mergeBase === undefined ? (
      connected ? (
        <PaneMessage icon={Spinner} text="Loading branches…" />
      ) : (
        <PaneMessage icon={WifiOff} text="Not connected to the server." />
      )
    ) : (
      <PaneMessage icon={GitBranch} text="No base branch to compare with" />
    );

  // `h-full` so the file list scrolls inside the pane and the selector stays
  // put; the dock's own scroller then never has anything to scroll.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 p-2">
        <BranchLine status={status?._tag === "ok" ? status.value : null} onRefresh={refresh} />
        <ScopeBar
          scope={changesScope}
          onScopeChange={setChangesScope}
          diffStyle={diffStyle}
          onDiffStyleChange={setDiffStyle}
        />
        {changesScope === "turn" ? (
          <>
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
                onAccepted={onRestoreAccepted}
              />
            </div>
            <RestoreProgress restoring={restoring} failure={restoreFailure} />
          </>
        ) : null}
        {changesScope === "branch" && range?.mergeBase !== undefined ? (
          <BaseLine base={range.mergeBase} current={branchList?.current ?? null} />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
    </div>
  );
}
