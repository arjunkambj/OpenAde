/**
 * What `/` shows: the real starting point for a thread.
 *
 * There is no such thing as a thread without a project, so the screen is a
 * project pick — one click per project, dispatching the same `thread.create`
 * the sidebar button does and landing on the new thread. With no server it
 * says so and points at /welcome, which is the connection diagnostic.
 *
 * With a server and no projects the route redirects to /welcome, but this
 * screen still carries its own empty state, because that redirect cannot be
 * relied on: without it a fresh install lands on a heading, a subtitle about
 * picking a project, and nothing to pick — no link, no add action, no way
 * forward at all. The empty state below is what makes that a recoverable
 * screen rather than a dead end.
 */

import { Link } from "@tanstack/react-router";

import { Button } from "@OpenAde/ui/components/button";
import type { ProjectSummary } from "@OpenAde/contracts/orchestration";

import { Icon } from "@/lib/icon";
import { useCreateThread } from "@/lib/use-create-thread";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";

function ProjectRow({
  project,
  threadCount,
  disabled,
  onPick,
}: {
  readonly project: ProjectSummary;
  readonly threadCount: number;
  readonly disabled: boolean;
  readonly onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left outline-none transition-colors duration-150 ease-out hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon icon="hugeicons:folder-01" className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {project.workspaceRoot}
        </span>
      </span>
      <span className="shrink-0 type-micro text-muted-foreground">
        {threadCount === 1 ? "1 thread" : `${threadCount} threads`}
      </span>
      <Icon icon="hugeicons:add-01" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function StartThread() {
  const projects = useProjects();
  const threads = useThreadList();
  const connection = useConnectionState();
  const { create, pending } = useCreateThread();
  const connected = connection.status === "connected";

  const threadCount = (project: ProjectSummary): number =>
    threads.filter((thread) => thread.projectId === project.projectId).length;

  const empty = connected && projects.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-lg flex-col gap-5">
        <div className="flex flex-col gap-1.5 text-center">
          <h1 className="text-base font-medium text-foreground">
            {empty ? "No projects yet" : "Start a thread"}
          </h1>
          <p className="type-body text-muted-foreground">
            {!connected
              ? "No server is connected, so there is nothing to start a thread on yet."
              : empty
                ? "A thread belongs to a project — a directory on this machine the agent works in. Add one to start."
                : "Pick the project to work in. Everything the thread does happens in its workspace root."}
          </p>
        </div>

        {!connected ? (
          <div className="flex justify-center">
            <Button type="button" variant="outline" render={<Link to="/welcome" />}>
              <Icon icon="hugeicons:wifi-off-01" className="size-4" />
              Connection details
            </Button>
          </div>
        ) : empty ? (
          <div className="flex justify-center">
            <Button type="button" render={<Link to="/welcome" />}>
              <Icon icon="hugeicons:folder-add" className="size-4" />
              Add a project
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projects.map((project) => (
              <ProjectRow
                key={project.projectId}
                project={project}
                threadCount={threadCount(project)}
                disabled={pending}
                onPick={() => void create(project.projectId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
