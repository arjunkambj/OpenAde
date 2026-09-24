/**
 * The thread header's git actions: a Commit button and a menu with Commit,
 * Commit & push, and Commit, push & create PR — plus View pull request once
 * this thread has opened (or found) one.
 *
 * An action is planned from the workspace's status and branches
 * (`@/lib/git-actions`): any action that commits opens the commit dialog
 * first, and a pull request made in the same run takes its title and body
 * from the commit message. Unchecking every file there skips the commit and
 * runs what is left. With nothing to commit, a push runs straight away and a
 * pull request asks only for its title and body. The steps then run in
 * order with one toast each, and stop at the first refusal with the server's
 * message (`./use-git-actions`).
 *
 * The whole control is disabled while this thread's turn runs, and each
 * action that cannot run says why — in the button's tooltip, or under the
 * menu item. The status is refetched when a turn finishes, because the agent
 * changes files, and when the user comes back to the window or opens the
 * menu, because an editor or a terminal changes them too — without that, a
 * Commit disabled as "No changes to commit" would stay so after an outside
 * edit, with no click of its own to refresh it. When the status cannot be
 * read (offline, or a client that serves no git) the control is disabled
 * with the reason instead of failing the header. Outside a repository it
 * renders nothing.
 */

import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitBranchList } from "@OpenAde/contracts/git";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import type { GitStatus } from "@OpenAde/contracts/rpc";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { openExternal } from "@/lib/desktop";
import {
  availableActions,
  GIT_ACTION_LABEL,
  GIT_ACTIONS,
  planGitAction,
  planWithoutCommit,
  pullRequestFromMessage,
  pullRequestTitleDraft,
  pushTargetOf,
  stepsLabel,
  TURN_RUNNING_REASON,
  type GitAction,
} from "@/lib/git-actions";
import { turnInFlight } from "@/lib/turn";
import { useWindowReturn } from "@/lib/window-return";
import { useConnectionState } from "@/state/hooks";
import {
  ChevronDown,
  CloudUpload,
  ExternalLink,
  Git,
  GitPullRequest,
  Spinner,
} from "@honeyicons/react";

import { CommitDialog, type CommitChoice } from "./commit-dialog";
import { PullRequestDialog } from "./pull-request-dialog";
import { useGitActions, type GitRunInput } from "./use-git-actions";

/** A git read as the control needs it: a value, still loading, or why it cannot be had. */
type Read<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "unavailable"; readonly reason: string };

const readOf = <A,>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
  connected: boolean,
): Read<A> => {
  if (AsyncResult.isFailure(result)) {
    return { _tag: "unavailable", reason: "Could not read this workspace's git status." };
  }
  if (!AsyncResult.isSuccess(result)) {
    return connected
      ? { _tag: "loading" }
      : { _tag: "unavailable", reason: "Not connected to the server." };
  }
  return result.value._tag === "ok"
    ? { _tag: "ok", value: result.value.value }
    : { _tag: "unavailable", reason: result.value.message };
};

const ACTION_ICON: Record<GitAction, typeof Git> = {
  commit: Git,
  "commit-push": CloudUpload,
  "commit-push-pr": GitPullRequest,
};

/** Which dialog is up. `key` remounts it per opening, so each opening starts from a fresh draft. */
type OpenDialog =
  | { readonly kind: "commit"; readonly action: GitAction; readonly key: number }
  | { readonly kind: "pull-request"; readonly action: GitAction; readonly key: number };

export function GitActionsControl({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const { gitStatusAtom, gitBranchesAtom, refreshProject } = useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connected = useConnectionState().status === "connected";
  const scope = { projectId: snapshot.projectId, threadId: snapshot.threadId };
  const statusAtom = gitStatusAtom(scope);
  const status = readOf<GitStatus>(useAtomValue(statusAtom), connected);
  const branches = readOf<GitBranchList>(useAtomValue(gitBranchesAtom(scope)), connected);
  const refreshStatus = useAtomRefresh(statusAtom);
  const { run, pullRequestUrl } = useGitActions(snapshot);

  const [dialog, setDialog] = React.useState<OpenDialog | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  // The agent changes files; its turn is over when `currentTurnId` falls back to null.
  const currentTurnId = snapshot.currentTurnId;
  const lastTurnId = React.useRef(currentTurnId);
  React.useEffect(() => {
    const previous = lastTurnId.current;
    lastTurnId.current = currentTurnId;
    if (previous !== null && currentTurnId === null) {
      refreshStatus();
    }
  }, [currentTurnId, refreshStatus]);
  useWindowReturn(() => refreshProject(registry, snapshot.projectId));

  if (
    (status._tag === "ok" && status.value.isRepository === false) ||
    (branches._tag === "ok" && !branches.value.isRepository)
  ) {
    return null;
  }

  const ready =
    status._tag === "ok" && branches._tag === "ok"
      ? { status: status.value, branches: branches.value }
      : null;
  const turnRunning = turnInFlight(snapshot);
  const blocked =
    status._tag === "unavailable"
      ? status.reason
      : branches._tag === "unavailable"
        ? branches.reason
        : ready === null
          ? "Reading the git status…"
          : turnRunning
            ? TURN_RUNNING_REASON
            : null;
  const availability = ready === null ? null : availableActions({ ...ready, turnRunning });
  const reasonFor = (action: GitAction): string | null => blocked ?? availability?.[action] ?? null;

  /** Plans from the status as it is now, not as it was when the dialog opened. */
  const execute = async (action: GitAction, input: GitRunInput) => {
    if (ready === null) {
      return;
    }
    setPending(true);
    try {
      await run(
        input.commit === undefined
          ? planWithoutCommit(action, ready.status, ready.branches)
          : planGitAction(action, ready.status, ready.branches),
        input,
        pushTargetOf(ready.status, ready.branches),
      );
    } finally {
      setPending(false);
    }
  };

  const start = (action: GitAction) => {
    if (ready === null || reasonFor(action) !== null) {
      return;
    }
    const steps = planGitAction(action, ready.status, ready.branches);
    if (steps.includes("commit")) {
      refreshStatus();
      setDialog({ kind: "commit", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else if (steps.includes("pr")) {
      setDialog({ kind: "pull-request", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else {
      void execute(action, {});
    }
  };

  const commitChosen = (action: GitAction, choice: CommitChoice) =>
    void execute(action, {
      ...(choice.paths?.length === 0 ? {} : { commit: choice }),
      ...(action === "commit-push-pr"
        ? { pullRequest: pullRequestFromMessage(choice.message) }
        : {}),
    });

  const disabled = blocked !== null || pending;
  const commitReason = reasonFor("commit");
  const files = ready?.status.files ?? [];
  const branch = ready?.status.branch ?? null;

  return (
    <div className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || commitReason !== null}
            onClick={() => start("commit")}
            aria-label="Commit"
          >
            {pending ? <Spinner variant="bold" /> : <Git variant="bold" />}
            {/* A narrow header keeps the branch name over this label. */}
            <span className="hidden @lg/header:inline">Commit</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{commitReason ?? "Commit the changes in this workspace"}</TooltipContent>
      </Tooltip>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) refreshStatus();
        }}
      >
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label="More git actions"
                />
              }
            >
              <ChevronDown variant="bold" />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{blocked ?? "More git actions"}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          {GIT_ACTIONS.map((action) => {
            const Icon = ACTION_ICON[action];
            const reason = reasonFor(action);
            return (
              <DropdownMenuItem
                key={action}
                disabled={reason !== null}
                onClick={() => start(action)}
              >
                <Icon variant="bold" />
                <span className="flex min-w-0 flex-col">
                  <span>{GIT_ACTION_LABEL[action]}</span>
                  {reason === null ? null : (
                    <span className="text-xs text-muted-foreground">{reason}</span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
          {pullRequestUrl === null ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openExternal(pullRequestUrl)}>
                <ExternalLink variant="bold" />
                View pull request
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog?.kind === "commit" ? (
        <CommitDialog
          key={dialog.key}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          actionLabel={GIT_ACTION_LABEL[dialog.action]}
          withoutCommitLabel={
            ready === null
              ? null
              : stepsLabel(planWithoutCommit(dialog.action, ready.status, ready.branches))
          }
          threadTitle={snapshot.title}
          branch={branch}
          files={files}
          onSubmit={(choice) => commitChosen(dialog.action, choice)}
        />
      ) : null}
      {dialog?.kind === "pull-request" ? (
        <PullRequestDialog
          key={dialog.key}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          actionLabel={
            (ready === null
              ? null
              : stepsLabel(planWithoutCommit(dialog.action, ready.status, ready.branches))) ??
            "Create PR"
          }
          initialTitle={pullRequestTitleDraft(snapshot.title, branch)}
          branch={branch}
          onSubmit={(pullRequest) => void execute(dialog.action, { pullRequest })}
        />
      ) : null}
    </div>
  );
}
