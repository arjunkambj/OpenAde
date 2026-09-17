/**
 * "Add project" — a name plus a workspace root, dispatched as
 * `project.create`. Kept deliberately small; richer project management is not
 * part of the renderer shell.
 */

import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@OpenAde/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@OpenAde/ui/components/dialog";
import { Input } from "@OpenAde/ui/components/input";
import { Label } from "@OpenAde/ui/components/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { makeCommandId, makeProjectId } from "@OpenAde/contracts/ids";

import { Icon } from "@/lib/icon";
import { useDispatchCommand } from "@/state/hooks";

export function AddProjectDialog({ disabled }: { disabled?: boolean }) {
  const dispatch = useDispatchCommand();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [workspaceRoot, setWorkspaceRoot] = React.useState("");
  const [pending, setPending] = React.useState(false);

  const canSubmit = name.trim().length > 0 && workspaceRoot.trim().length > 0 && !pending;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "project.create",
      projectId: makeProjectId(),
      name: name.trim(),
      workspaceRoot: workspaceRoot.trim(),
    });
    setPending(false);
    if (Exit.isSuccess(exit) && exit.value.status === "accepted") {
      setOpen(false);
      setName("");
      setWorkspaceRoot("");
      return;
    }
    toast.error(
      Exit.isSuccess(exit)
        ? (exit.value.reason ?? "Project was rejected")
        : "Could not reach the server",
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add project"
                  disabled={disabled}
                />
              }
            />
          }
        >
          <Icon icon="hugeicons:folder-add" />
        </TooltipTrigger>
        <TooltipContent>Add project</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            A project groups threads around one workspace root on this machine.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-app"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-root">Workspace root</Label>
            <Input
              id="project-root"
              value={workspaceRoot}
              onChange={(event) => setWorkspaceRoot(event.target.value)}
              placeholder="/Users/you/code/my-app"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
