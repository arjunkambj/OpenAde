/**
 * The per-project overflow menu: a shortcut to the project's setup script on
 * the Git & worktrees settings page, and removing the project — a menu rather
 * than a bare button, because removing one is not something to put a click
 * away from "New thread".
 *
 * `project.remove` was in the union with no dispatch site anywhere, so a
 * project whose path was mistyped could only be dropped by editing the sqlite
 * file by hand. What it does is not obvious from its name, either:
 * `ProviderCommandReactor` dispatches a `thread.delete` for every thread under
 * it, so the confirmation says so and counts them — see `./removal-copy`. It
 * removes no worktrees, and the confirmation says that too when any of those
 * threads has one.
 */

import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ProjectSummary } from "@OpenAde/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { projectRemovalWarning } from "@/components/sidebar/removal-copy";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";
import { GitBranch, MoreHorizontal, Trash } from "@honeyicons/react";

export function ProjectRowMenu({
  project,
  threadCount,
  worktreeCount,
}: {
  readonly project: ProjectSummary;
  readonly threadCount: number;
  /** How many of those threads have their own worktree. */
  readonly worktreeCount: number;
}) {
  const dispatch = useDispatchCommand();
  const navigate = useNavigate();
  const [confirming, setConfirming] = React.useState(false);

  const remove = async () => {
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "project.remove",
      projectId: project.projectId,
    });
    if (!isAccepted(exit)) {
      toast.error(rejectionMessage(exit, "Project was not removed"));
    }
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${project.name}`}
                  />
                }
              />
            }
          >
            <MoreHorizontal variant="bold" />
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => void navigate({ to: "/settings/git" })}>
            <GitBranch />
            Setup script…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            <Trash variant="bold" />
            Remove project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${project.name}?`}
        description={projectRemovalWarning(
          project.name,
          threadCount,
          project.workspaceRoot,
          worktreeCount,
        )}
        confirmLabel="Remove project"
        onConfirm={() => void remove()}
      />
    </>
  );
}
