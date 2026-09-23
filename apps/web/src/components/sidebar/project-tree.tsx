/**
 * The projects → threads tree: projects from `projectsAtom`, threads from
 * `threadListAtom(null)` grouped client-side by `projectId`. Each thread row
 * links to `/t/$threadId` with a status slot, the title and a relative time —
 * see `./thread-row`. Anything waiting on the user outranks a turn in flight
 * and gets the icon and label together — see `./thread-status`.
 *
 * A row also carries the unread dot: the open thread stamps its `updatedAt`
 * into `thread-seen`, and any other thread that has moved past its own stamp
 * is marked. That is renderer state by design — see `./thread-seen`.
 *
 * The tree owns the one-minute tick behind every row's relative time, so a
 * long list runs one interval rather than one per row.
 *
 * A project row folds its threads away on click; the folded set persists
 * through `useProjectCollapsed`. The open thread stays listed under a folded
 * project, so the sidebar never loses track of where you are.
 *
 * Archived threads are not listed: they live on Settings → Archived threads.
 * The one exception is the thread that is open, which stays in place and looks
 * archived, for the same reason and because its menu carries Unarchive — see
 * `./visible-threads`.
 *
 * Every row has an overflow menu, revealed on hover: rename/archive/delete for
 * a thread, remove for a project. A thread row also offers archive on its own.
 * Those four commands existed end to end — decider, reactors, tests — with
 * nothing in the UI that could send them, so the sidebar only ever grew and a
 * mistyped project root could not be dropped.
 */

import { useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@OpenAde/contracts/orchestration";

import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import { ProjectRowMenu } from "@/components/sidebar/project-menu";
import { ThreadRow } from "@/components/sidebar/thread-row";
import { sidebarThreads } from "@/components/sidebar/visible-threads";
import { SHORTCUT_COMMANDS } from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";
import { useProjectCollapsed } from "@/state/ui";
import { Add, ChevronRight, Folder, FolderOpen } from "@honeyicons/react";

function NewThreadButton({
  projectId,
  onCreated,
}: {
  projectId: ProjectId;
  onCreated: () => void;
}) {
  const connection = useConnectionState();
  const { create, pending } = useCreateThread();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New thread"
            disabled={pending || connection.status !== "connected"}
            onClick={() => {
              void create(projectId).then((accepted) => {
                if (accepted) {
                  onCreated();
                }
              });
            }}
          />
        }
      >
        <Add />
      </TooltipTrigger>
      <TooltipContent>New thread</TooltipContent>
    </Tooltip>
  );
}

function groupByProject(
  threads: ReadonlyArray<ThreadSummary>,
): ReadonlyMap<ProjectId, ThreadSummary[]> {
  const map = new Map<ProjectId, ThreadSummary[]>();
  for (const thread of threads) {
    const list = map.get(thread.projectId) ?? [];
    list.push(thread);
    map.set(thread.projectId, list);
  }
  return map;
}

export function ProjectTree() {
  const projects = useProjects();
  const threads = useThreadList();
  const connection = useConnectionState();
  const now = useNow(60_000);
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;
  const shown = React.useMemo(() => sidebarThreads(threads, openThreadId), [threads, openThreadId]);

  const threadsByProject = React.useMemo(() => groupByProject(shown), [shown]);
  // Removing a project deletes its archived threads too, so the removal copy
  // counts every thread, not only the listed ones.
  const threadCounts = React.useMemo(() => {
    const counts = new Map<ProjectId, number>();
    for (const thread of threads) {
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    }
    return counts;
  }, [threads]);

  // Threads whose project is gone from the list still get a home.
  const knownProjects = React.useMemo(
    () => new Set(projects.map((project) => project.projectId)),
    [projects],
  );
  const orphanThreads = shown.filter((thread) => !knownProjects.has(thread.projectId));

  return (
    <SidebarGroup padding="section" className="min-h-0 flex-1">
      <div className="flex h-8 items-center gap-1">
        <SidebarGroupLabel className="h-auto flex-1">Projects</SidebarGroupLabel>
        <AddProjectDialog
          disabled={connection.status !== "connected"}
          command={SHORTCUT_COMMANDS.addProject}
        />
      </div>
      <SidebarGroupContent className="mt-1 min-h-0 overflow-y-auto [scrollbar-width:none]">
        {projects.length === 0 && orphanThreads.length === 0 ? (
          <p className="px-2 py-4 type-micro text-muted-foreground">
            {connection.status === "connected"
              ? "No projects yet — add one to start a thread."
              : "Connect to a server to see projects."}
          </p>
        ) : null}
        <div className="grid min-w-0 gap-0.5">
          {projects.map((project) => (
            <ProjectSection
              key={project.projectId}
              project={project}
              threads={threadsByProject.get(project.projectId) ?? []}
              threadCount={threadCounts.get(project.projectId) ?? 0}
              now={now}
            />
          ))}
          {orphanThreads.length > 0 ? (
            <>
              <div className="flex h-8 items-center gap-2.5 rounded-xl px-2 text-sm text-sidebar-foreground">
                <Folder className="size-4 shrink-0" />
                <span className="min-w-0 truncate">Other threads</span>
              </div>
              <SidebarMenu>
                {orphanThreads.map((thread) => (
                  <ThreadRow key={thread.threadId} thread={thread} now={now} />
                ))}
              </SidebarMenu>
            </>
          ) : null}
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ProjectSection({
  project,
  threads,
  threadCount,
  now,
}: {
  project: ProjectSummary;
  threads: ReadonlyArray<ThreadSummary>;
  threadCount: number;
  now: number;
}) {
  const [collapsed, setCollapsed] = useProjectCollapsed(project.projectId);
  const matchRoute = useMatchRoute();
  const shown = collapsed
    ? threads.filter((thread) =>
        Boolean(matchRoute({ to: "/t/$threadId", params: { threadId: thread.threadId } })),
      )
    : threads;

  return (
    <React.Fragment>
      <div className="group/project flex h-8 items-center gap-1 rounded-xl text-sm text-sidebar-foreground">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-xl px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {/* The folder turns into the disclosure chevron under the pointer. */}
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            {collapsed ? (
              <Folder className="size-4 transition-opacity duration-150 ease-out group-hover/project:opacity-0" />
            ) : (
              <FolderOpen className="size-4 transition-opacity duration-150 ease-out group-hover/project:opacity-0" />
            )}
            <ChevronRight
              className={cn(
                "absolute size-4 opacity-0 transition-all duration-150 ease-out group-hover/project:opacity-100",
                !collapsed && "rotate-90",
              )}
            />
          </span>
          <span className="ml-1.5 min-w-0 flex-1 truncate">{project.name}</span>
        </button>
        <span className="flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover/project:opacity-100 group-focus-within/project:opacity-100 [&:has([data-popup-open])]:opacity-100">
          <ProjectRowMenu project={project} threadCount={threadCount} />
          <NewThreadButton projectId={project.projectId} onCreated={() => setCollapsed(false)} />
        </span>
      </div>
      {shown.length > 0 ? (
        <SidebarMenu>
          {shown.map((thread) => (
            <ThreadRow key={thread.threadId} thread={thread} now={now} />
          ))}
        </SidebarMenu>
      ) : null}
    </React.Fragment>
  );
}
