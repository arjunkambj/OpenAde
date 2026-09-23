/**
 * The projects → threads tree: projects from `projectsAtom`, threads from
 * `threadListAtom(null)` grouped client-side by `projectId`. Each thread row
 * links to `/t/$threadId` and shows its status dot; anything waiting on the
 * user outranks a turn in flight and gets the permission accent, icon and
 * label together — see `./thread-status`.
 *
 * A row also carries the unread dot: the open thread stamps its `updatedAt`
 * into `thread-seen`, and any other thread that has moved past its own stamp
 * is marked. That is renderer state by design — see `./thread-seen`.
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
 * a thread, remove for a project. Those four commands existed end to end —
 * decider, reactors, tests — with nothing in the UI that could send them, so
 * the sidebar only ever grew and a mistyped project root could not be dropped.
 */

import { Link, useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@OpenAde/contracts/orchestration";

import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import { ProjectRowMenu } from "@/components/sidebar/project-menu";
import { ThreadRowMenu } from "@/components/sidebar/thread-menu";
import { isUnread, useThreadSeen } from "@/components/sidebar/thread-seen";
import { threadStatusMark } from "@/components/sidebar/thread-status";
import { sidebarThreads } from "@/components/sidebar/visible-threads";
import { useCreateThread } from "@/lib/use-create-thread";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";
import { useProjectCollapsed } from "@/state/ui";
import { Add, ChevronRight, Folder, FolderOpen } from "@honeyicons/react";

function ThreadStatusDot({ thread }: { thread: ThreadSummary }) {
  const mark = threadStatusMark(thread);
  if (mark === null) {
    return null;
  }
  return (
    <span
      title={mark.label}
      aria-label={mark.label}
      role="img"
      className="flex shrink-0 items-center"
    >
      <mark.icon className={cn("size-3.5 shrink-0", mark.tone)} />
    </span>
  );
}

function ThreadLink({ thread }: { thread: ThreadSummary }) {
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to: "/t/$threadId", params: { threadId: thread.threadId } }));
  const [seen, remember] = useThreadSeen();
  const { threadId, updatedAt } = thread;

  // The open thread is being read right now, so every event it takes is seen.
  React.useEffect(() => {
    if (active) {
      remember(threadId, updatedAt);
    }
  }, [active, threadId, updatedAt, remember]);

  const unread = !active && isUnread(seen, thread);

  // The row is a link plus an overflow menu overlaid at its right edge. The
  // status and unread marks fade out under it on hover, so the two never share
  // the same few pixels. The row's own `pl-2` starts the highlight under the
  // project's folder icon; the title still lines up with the project name.
  return (
    <div className="group/thread relative flex min-w-0 items-center pl-2">
      <Link
        to="/t/$threadId"
        params={{ threadId: thread.threadId }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-xl py-1 pr-0 pl-6.5 text-left type-body text-sidebar-foreground outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            unread && "font-medium text-foreground",
            // Archiving is a real state change that the row otherwise showed
            // nothing for: `threadStatusMark` has no mark for it by design.
            // Only the open thread can be listed while archived.
            thread.status === "archived" && "text-muted-foreground italic",
          )}
          title={thread.status === "archived" ? `${thread.title} (archived)` : undefined}
        >
          {thread.title}
        </span>
        <span className="flex shrink-0 items-center gap-2 transition-opacity duration-150 ease-out group-hover/thread:opacity-0">
          {unread ? (
            <span
              title="Updated since you last opened it"
              aria-label="Updated since you last opened it"
              role="img"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          ) : null}
          <ThreadStatusDot thread={thread} />
        </span>
      </Link>
      {/* Same reveal as the project row's "New thread" button, plus a hold
          while its own popup is open — base-ui moves focus into the portalled
          menu, so `focus-within` on this row is false the whole time it is. */}
      <span className="absolute right-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 [&:has([data-popup-open])]:opacity-100">
        <ThreadRowMenu thread={thread} />
      </span>
    </div>
  );
}

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
        <AddProjectDialog disabled={connection.status !== "connected"} />
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
            />
          ))}
          {orphanThreads.length > 0 ? (
            <>
              <div className="flex h-8 items-center gap-2.5 rounded-xl px-2 text-sm text-sidebar-foreground">
                <Folder className="size-4 shrink-0" />
                <span className="min-w-0 truncate">Other threads</span>
              </div>
              {orphanThreads.map((thread) => (
                <ThreadLink key={thread.threadId} thread={thread} />
              ))}
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
}: {
  project: ProjectSummary;
  threads: ReadonlyArray<ThreadSummary>;
  threadCount: number;
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
      {shown.map((thread) => (
        <ThreadLink key={thread.threadId} thread={thread} />
      ))}
    </React.Fragment>
  );
}
