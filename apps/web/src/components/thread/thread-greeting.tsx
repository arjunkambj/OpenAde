/**
 * The middle of a thread with nothing in it yet — a fresh thread, or `/`
 * before its first message: one line asking what to build, naming the
 * project the agent will work in. Both screens pin the composer underneath,
 * so starting a thread and opening an empty one look the same.
 */

import type { ProjectSummary } from "@OpenAde/contracts/orchestration";

export function ThreadGreeting({ project }: { readonly project: ProjectSummary | undefined }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center">
      <h2 className="text-2xl font-medium tracking-tight text-foreground">
        {project === undefined ? (
          "What are we cooking today?"
        ) : (
          <>
            What are we cooking in{" "}
            <span
              className="underline decoration-muted-foreground decoration-dotted decoration-1 underline-offset-4"
              title={project.workspaceRoot}
            >
              {project.name}
            </span>
            ?
          </>
        )}
      </h2>
    </div>
  );
}
