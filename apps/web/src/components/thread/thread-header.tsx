/**
 * The thread's slim header: its title, the worktree it works in when it has
 * one, its status and the dock toggle.
 *
 * A worktree thread shows its branch beside the title, with the directory in
 * the tooltip, because the agent's edits land there and not in the project's
 * folder — the header is where that stays in view once the thread has
 * messages and the greeting is gone.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadWorktree } from "@OpenAde/contracts/git";
import type { ThreadDetailSnapshot, ThreadStatus } from "@OpenAde/contracts/orchestration";

import type { DockTab } from "@/components/dock/right-dock";
import { cn } from "@/lib/utils";
import { GitFork, SidebarRight, Spinner } from "@honeyicons/react";

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  error: "Error",
  archived: "Archived",
  deleted: "Deleted",
};

function StatusPill({ status }: { status: ThreadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 type-micro",
        (status === "error" || status === "deleted") && "bg-removed-bg text-removed",
        status === "waiting" && "text-permission",
        (status === "idle" || status === "archived") && "text-muted-foreground",
      )}
    >
      {status === "running" ? <Spinner className="size-3" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

function WorktreeBadge({ worktree }: { worktree: ThreadWorktree }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={`Worktree ${worktree.branch} at ${worktree.path}`}
            className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-hover px-2 py-0.5 type-micro text-muted-foreground"
          />
        }
      >
        <GitFork className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{worktree.branch}</span>
      </TooltipTrigger>
      <TooltipContent>
        Works in its own worktree: {worktree.path}
        {worktree.baseBranch === undefined ? null : ` (cut from ${worktree.baseBranch})`}
      </TooltipContent>
    </Tooltip>
  );
}

export function ThreadHeader({
  snapshot,
  dockTab,
  onDockToggle,
}: {
  snapshot: ThreadDetailSnapshot;
  dockTab: DockTab | undefined;
  onDockToggle: () => void;
}) {
  return (
    <header className="flex min-h-11 shrink-0 items-center gap-2 px-4 py-1.5">
      <h1 className="min-w-0 max-w-56 shrink truncate text-sm font-medium text-foreground">
        {snapshot.title}
      </h1>
      {snapshot.worktree === undefined ? null : <WorktreeBadge worktree={snapshot.worktree} />}
      <div className="flex-1" />
      <StatusPill status={snapshot.status} />
      <span className="inline-flex shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={dockTab === undefined ? "Open dock" : "Close dock"}
                aria-pressed={dockTab !== undefined}
                onClick={onDockToggle}
              />
            }
          >
            <SidebarRight className={cn(dockTab !== undefined && "text-foreground")} />
          </TooltipTrigger>
          <TooltipContent>{dockTab === undefined ? "Open dock" : "Close dock"}</TooltipContent>
        </Tooltip>
      </span>
    </header>
  );
}
