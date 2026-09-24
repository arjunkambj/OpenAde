/**
 * The lines above the Changes pane's file list: the branch the workspace is
 * on, what "Branch vs base" compares with, and the tail of a restore.
 */

import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { GitStatus } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { AlertTriangle, GitBranch, GitDiff, Repeat, Spinner } from "@honeyicons/react";

/** The branch line: what the worktree is on, and how far it has drifted. */
export function BranchLine({
  status,
  onRefresh,
}: {
  status: GitStatus | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-7 items-center gap-1.5 type-micro text-muted-foreground">
      <GitBranch variant="bold" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{status?.branch ?? "no branch"}</span>
      {status !== null && status.ahead > 0 ? <span>↑{status.ahead}</span> : null}
      {status !== null && status.behind > 0 ? <span>↓{status.behind}</span> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh changes"
              className="ml-auto"
              onClick={onRefresh}
            />
          }
        >
          <Repeat variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Refresh changes</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * What "Branch vs base" compares with. On the base branch itself the fork
 * point is `HEAD` (or behind it), so the diff is only the uncommitted work —
 * said out loud, or an empty list would read as "the branch has no commits".
 */
export function BaseLine({ base, current }: { base: string; current: string | null }) {
  return (
    <div className="flex items-start gap-1.5 type-micro text-muted-foreground">
      <GitDiff variant="bold" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">
        {current === base ? (
          <>
            You are on <span className="font-mono">{base}</span> itself, so only uncommitted work
            shows.
          </>
        ) : (
          <>
            Compared with <span className="font-mono">{base}</span> from where this branch forked,
            uncommitted work included.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The tail of a restore: running, or the reason git refused the last one. The
 * failure line stays up until another restore is ordered — it is the only
 * place that message is ever shown, and it arrives long after the dialog that
 * started the restore has closed.
 */
export function RestoreProgress({
  restoring,
  failure,
}: {
  restoring: CheckpointSummary | null;
  failure: { readonly message: string } | null;
}) {
  if (restoring !== null) {
    return (
      <div role="status" className="flex items-center gap-2 type-micro text-muted-foreground">
        <Spinner variant="bold" className="size-3.5" />
        <span className="min-w-0 truncate">Restoring the worktree…</span>
      </div>
    );
  }
  if (failure !== null) {
    return (
      <div role="alert" className="flex items-start gap-2 type-micro text-removed">
        <AlertTriangle variant="bold" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">Restore failed: {failure.message}</span>
      </div>
    );
  }
  return null;
}
