/**
 * The projects → threads tree: projects from `projectsAtom`, threads from
 * `threadListAtom(null)` grouped client-side by `projectId`. Each thread row
 * links to `/t/$threadId` and shows its status dot; `awaitingInput` gets the
 * permission accent since something is waiting on the user.
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
import { Icon } from "@/lib/icon";
import { useCreateThread } from "@/lib/use-create-thread";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";

function ThreadStatusDot({ thread }: { thread: ThreadSummary }) {
  if (thread.status === "running") {
    return (
      <Icon
        icon="hugeicons:loading-03"
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (thread.status === "waiting" || thread.awaitingInput) {
    return <Icon icon="hugeicons:circle-dot" className="size-3.5 shrink-0 text-permission" />;
  }
  if (thread.status === "error") {
    return <Icon icon="hugeicons:alert-circle" className="size-3.5 shrink-0 text-destructive" />;
  }
  return null;
}

function ThreadLink({ thread }: { thread: ThreadSummary }) {
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to: "/t/$threadId", params: { threadId: thread.threadId } }));
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.threadId }}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 pl-8.5 text-left type-body text-sidebar-foreground outline-none transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <ThreadStatusDot thread={thread} />
    </Link>
  );
}

function NewThreadButton({ projectId }: { projectId: ProjectId }) {
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
            onClick={() => void create(projectId)}
          />
        }
      >
        <Icon icon="hugeicons:add-01" />
      </TooltipTrigger>
      <TooltipContent>New thread</TooltipContent>
    </Tooltip>
  );
}

export function ProjectTree() {
  const projects = useProjects();
  const threads = useThreadList();
  const connection = useConnectionState();

  const threadsByProject = React.useMemo(() => {
    const map = new Map<ProjectId, ThreadSummary[]>();
    for (const thread of threads) {
      const list = map.get(thread.projectId) ?? [];
      list.push(thread);
      map.set(thread.projectId, list);
    }
    return map;
  }, [threads]);

  // Threads whose project is gone from the list still get a home.
  const knownProjects = React.useMemo(
    () => new Set(projects.map((project) => project.projectId)),
    [projects],
  );
  const orphanThreads = threads.filter((thread) => !knownProjects.has(thread.projectId));

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
            />
          ))}
          {orphanThreads.length > 0 ? (
            <>
              <div className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm text-sidebar-foreground">
                <Icon
                  icon="hugeicons:folder-01"
                  className="size-4 shrink-0 text-muted-foreground"
                />
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
}: {
  project: ProjectSummary;
  threads: ReadonlyArray<ThreadSummary>;
}) {
  return (
    <React.Fragment>
      <div className="group/project flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-sidebar-foreground">
        <Icon icon="hugeicons:folder-01" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="opacity-0 transition-opacity duration-150 ease-out group-hover/project:opacity-100 group-focus-within/project:opacity-100">
          <NewThreadButton projectId={project.projectId} />
        </span>
      </div>
      {threads.map((thread) => (
        <ThreadLink key={thread.threadId} thread={thread} />
      ))}
    </React.Fragment>
  );
}
