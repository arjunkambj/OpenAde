/**
 * The branch control in the thread header: the branch the thread's workspace
 * is on, and — for a local thread — a searchable list to switch to another
 * branch or create one.
 *
 * - **Local thread.** The workspace is the project's own folder, shared with
 *   every other local thread of the project, so a switch moves all of them;
 *   the popover says so. Picking a branch runs `git.checkout`; the
 *   `Create branch "<query>"` item cuts the query from the current branch and
 *   switches to it. The server refuses a dirty tracked tree or a running turn
 *   in that folder, and the refusal is a toast — nothing is stashed for the
 *   user. The trigger is disabled while this thread's own turn runs.
 * - **Worktree thread.** The thread owns its worktree's branch, so the popover
 *   only shows the branch, its base and the directory, with no switching.
 *
 * The git atoms refetch the project's branches, status and diffs after a
 * write. The agent can switch branches too, so a finished turn refetches the
 * list the same way the Changes pane refetches its diff. When the list cannot
 * be read — offline, or a client that does not serve git at all — the trigger
 * is disabled and its tooltip says why, rather than the header failing.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@OpenAde/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@OpenAde/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitBranchList } from "@OpenAde/contracts/git";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { useBranchWrites, useGitAtoms } from "@/components/panes/changes/git-atoms";
import { turnInFlight } from "@/lib/turn";
import { useConnectionState } from "@/state/hooks";
import { GitBranch, GitFork, Spinner } from "@honeyicons/react";

import { branchWriteFailure } from "./branches";
import { BranchList } from "./branch-list";
import { WorktreeDetails } from "./worktree-details";

/** The branch list as the picker reads it: a value, a refusal, or a client that cannot answer. */
type BranchesState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly list: GitBranchList }
  | { readonly _tag: "unavailable"; readonly reason: string };

const branchesState = (
  result: AsyncResult.AsyncResult<GitQuery<GitBranchList>, unknown>,
  connected: boolean,
): BranchesState => {
  if (AsyncResult.isFailure(result)) {
    return { _tag: "unavailable", reason: "Could not read this workspace's branches." };
  }
  if (!AsyncResult.isSuccess(result)) {
    return connected
      ? { _tag: "loading" }
      : { _tag: "unavailable", reason: "Not connected to the server." };
  }
  const query = result.value;
  return query._tag === "ok"
    ? { _tag: "ok", list: query.value }
    : { _tag: "unavailable", reason: query.message };
};

const RUNNING_REASON = "A turn is running — stop it before switching branches.";

export function BranchPicker({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const { gitBranchesAtom } = useGitAtoms();
  const { checkout, createBranch } = useBranchWrites();
  const connection = useConnectionState();
  const scope = { projectId: snapshot.projectId, threadId: snapshot.threadId };
  const branchesAtom = gitBranchesAtom(scope);
  const state = branchesState(useAtomValue(branchesAtom), connection.status === "connected");
  const refreshBranches = useAtomRefresh(branchesAtom);

  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  // The agent may have switched branches itself; its turn is over when
  // `currentTurnId` falls back to null.
  const currentTurnId = snapshot.currentTurnId;
  const lastTurnId = React.useRef(currentTurnId);
  React.useEffect(() => {
    const previous = lastTurnId.current;
    lastTurnId.current = currentTurnId;
    if (previous !== null && currentTurnId === null) {
      refreshBranches();
    }
  }, [currentTurnId, refreshBranches]);

  if (state._tag === "ok" && !state.list.isRepository) {
    return null;
  }

  const worktree = snapshot.worktree;
  const list = state._tag === "ok" ? state.list : null;
  const branch = list === null ? (worktree?.branch ?? null) : (list.current ?? "detached");

  const run = async (
    write: () => Promise<Parameters<typeof branchWriteFailure>[0]>,
    done: string,
  ) => {
    setOpen(false);
    setPending(true);
    const failure = branchWriteFailure(await write());
    setPending(false);
    if (failure === null) {
      toast.success(done);
    } else {
      toast.error(failure);
    }
  };

  const switchTo = (name: string) =>
    void run(() => checkout({ ...scope, branch: name }), `Switched to ${name}`);

  const create = (name: string) =>
    void run(
      () =>
        createBranch({
          ...scope,
          name,
          ...(list?.current == null ? {} : { from: list.current }),
          checkout: true,
        }),
      `Created and switched to ${name}`,
    );

  const disabledReason =
    state._tag === "unavailable"
      ? state.reason
      : state._tag === "loading"
        ? "Reading branches…"
        : worktree === undefined && turnInFlight(snapshot)
          ? RUNNING_REASON
          : null;
  const tooltip =
    disabledReason ??
    (worktree === undefined ? "Switch or create a branch" : `Worktree at ${worktree.path}`);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex min-w-0 shrink" />}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabledReason !== null || pending}
                aria-label={branch === null ? "Branch" : `Branch ${branch}`}
                // The stock Button does not shrink; this one must, or a long
                // branch overflows onto the controls beside it instead of
                // truncating.
                className="min-w-0 max-w-full shrink"
              />
            }
          >
            {pending || state._tag === "loading" ? (
              <Spinner variant="bold" />
            ) : (
              <GitBranch variant="bold" />
            )}
            {worktree === undefined ? null : <GitFork variant="bold" />}
            {branch === null ? null : <span className="min-w-0 truncate">{branch}</span>}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start">
        {worktree !== undefined ? (
          <WorktreeDetails worktree={worktree} current={list?.current ?? null} />
        ) : list !== null ? (
          <BranchList list={list} onSwitch={switchTo} onCreate={create} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
