/**
 * The per-project overflow menu. One entry today — remove the project — but a
 * menu rather than a bare button, because removing one is not something to put
 * a click away from "New thread".
 *
 * `project.remove` was in the union with no dispatch site anywhere, so a
 * project whose path was mistyped could only be dropped by editing the sqlite
 * file by hand. What it does is not obvious from its name, either:
 * `ProviderCommandReactor` dispatches a `thread.delete` for every thread under
 * it, so the confirmation says so and counts them — see `./removal-copy`.
 */

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ProjectSummary } from "@OpenAde/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { projectRemovalWarning } from "@/components/sidebar/removal-copy";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { Icon } from "@/lib/icon";
import { useDispatchCommand } from "@/state/hooks";

export function ProjectRowMenu({
  project,
  threadCount,
}: {
  readonly project: ProjectSummary;
  readonly threadCount: number;
}) {
  const dispatch = useDispatchCommand();
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
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${project.name}`}
            />
          }
        >
          <Icon icon="hugeicons:more-horizontal" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            <Icon icon="hugeicons:delete-02" />
            Remove project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${project.name}?`}
        description={projectRemovalWarning(project.name, threadCount, project.workspaceRoot)}
        confirmLabel="Remove project"
        onConfirm={() => void remove()}
      />
    </>
  );
}
