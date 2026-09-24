/**
 * The thread's slim header: a breadcrumb of its project and title, the
 * branch picker, the git actions, the agent-browser indicator, its status
 * and the dock toggle.
 *
 * The branch picker (`components/git/branch-picker.tsx`) sits beside the
 * title: the branch the thread's workspace is on, switchable for a local
 * thread, and marked as a worktree — with the directory in its tooltip — for
 * a thread that has one, because the agent's edits land there and not in the
 * project's folder. The header is where that stays in view once the thread
 * has messages and the greeting is gone.
 *
 * The git actions control (`components/git/git-actions-control.tsx`) sits at
 * the right, before the status: commit, push and open a pull request from
 * the thread's workspace.
 *
 * A narrow header (a small window, the dock open) squeezes the project, the
 * title and the branch, the only parts that shrink. The branch is the one
 * worth keeping, so the title gives up twice as much; the project gives up
 * no more than the branch, since a name cut to its first letter says
 * nothing. Below `@lg` the header (a container, `header`) has the Commit
 * button drop its label for its icon and tooltip.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadDetailSnapshot, ThreadStatus } from "@OpenAde/contracts/orchestration";

import type { DockTab } from "@/components/dock/right-dock";
import { BranchPicker } from "@/components/git/branch-picker";
import { GitActionsControl } from "@/components/git/git-actions-control";
import { AgentBrowserIndicator } from "@/components/thread/agent-browser-indicator";
import { CommandKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useProjects } from "@/state/hooks";
import { Folder, SidebarRight, Spinner } from "@honeyicons/react";

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
      {status === "running" ? <Spinner variant="bold" className="size-3" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ThreadHeader({
  snapshot,
  dockTab,
  onDockToggle,
  onShowBrowser,
}: {
  snapshot: ThreadDetailSnapshot;
  dockTab: DockTab | undefined;
  onDockToggle: () => void;
  /** Set while the agent uses the browser and its pane is not on screen. */
  onShowBrowser: (() => void) | null;
}) {
  const project = useProjects().find((candidate) => candidate.projectId === snapshot.projectId);

  return (
    <header className="@container/header flex min-h-11 shrink-0 items-center gap-2 px-6 py-1.5">
      {/* The breadcrumb reads as one phrase, so it sits tighter than the
          controls around it. */}
      <div className="flex min-w-0 items-center gap-1">
        {project === undefined ? null : (
          <>
            <span className="flex min-w-0 max-w-40 items-center gap-1.5 text-sm text-muted-foreground">
              <Folder variant="bold" className="size-4 shrink-0" />
              <span className="truncate">{project.name}</span>
            </span>
            <span aria-hidden className="shrink-0 text-sm text-muted-foreground/60">
              /
            </span>
          </>
        )}
        <h1 className="min-w-0 max-w-56 shrink-2 truncate text-sm font-medium text-foreground">
          {snapshot.title}
        </h1>
        <BranchPicker snapshot={snapshot} />
      </div>
      <div className="flex-1" />
      {onShowBrowser === null ? null : <AgentBrowserIndicator onShow={onShowBrowser} />}
      <GitActionsControl snapshot={snapshot} />
      {/* Idle is the resting state, not news: the pill shows only while
          something is happening or wrong. */}
      {snapshot.status === "idle" ? null : <StatusPill status={snapshot.status} />}
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
            <SidebarRight
              variant="bold"
              className={cn(dockTab !== undefined && "text-foreground")}
            />
          </TooltipTrigger>
          <TooltipContent>
            {dockTab === undefined ? "Open dock" : "Close dock"}
            <CommandKbd command="dock.toggle" />
          </TooltipContent>
        </Tooltip>
      </span>
    </header>
  );
}
