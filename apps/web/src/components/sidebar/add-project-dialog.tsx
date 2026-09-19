/**
 * "Add project" — a name plus a workspace root, dispatched as
 * `project.create`. Kept deliberately small; richer project management is not
 * part of the renderer shell.
 *
 * The root comes from the desktop's native directory picker where there is one
 * and from the renderer's own `fs.browse` picker everywhere else, and the name
 * defaults to the directory's own. The field stays typed either way — and a
 * path that cannot be a workspace root is said so here rather than travelling
 * to the server to come back as a rejection reason.
 */

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

import { FolderPickerDialog } from "@/components/folder-picker/folder-picker-dialog";
import { hasNativePicker, pickDirectory } from "@/lib/desktop";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { projectNameFromPath, workspacePathProblem } from "@/lib/workspace-path";
import { useDispatchCommand } from "@/state/hooks";
import { FolderAdd } from "@honeyicons/react";

/**
 * `icon` is the sidebar's ghost button; `button` is the labelled one the empty
 * start screen offers.
 */
export function AddProjectDialog({
  disabled,
  trigger = "icon",
}: {
  disabled?: boolean;
  trigger?: "icon" | "button";
}) {
  const dispatch = useDispatchCommand();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [workspaceRoot, setWorkspaceRoot] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [picking, setPicking] = React.useState(false);

  const pathProblem = workspacePathProblem(workspaceRoot);
  const canSubmit =
    name.trim().length > 0 && workspaceRoot.trim().length > 0 && pathProblem === null && !pending;

  /** A chosen root, from whichever picker chose it: it fills the field and
   * names the project after the directory unless the user already typed a name
   * of their own. */
  const accept = (picked: string) => {
    setWorkspaceRoot(picked);
    setName((current) =>
      current.trim() === "" || current === projectNameFromPath(workspaceRoot)
        ? projectNameFromPath(picked)
        : current,
    );
  };

  /** The desktop's own dialog where there is one, ours everywhere else. The
   * main process can fail to open the native one; say so rather than leaving a
   * button that looks dead, since the field below is still typeable. */
  const choose = async () => {
    if (!hasNativePicker()) {
      setPicking(true);
      return;
    }
    let picked: string | null;
    try {
      picked = await pickDirectory();
    } catch {
      toast.error("Could not open the directory picker");
      return;
    }
    if (picked === null) {
      return;
    }
    accept(picked);
  };

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
    if (isAccepted(exit)) {
      setOpen(false);
      setName("");
      setWorkspaceRoot("");
      return;
    }
    toast.error(rejectionMessage(exit, "Project was rejected"));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        {trigger === "button" ? (
          <DialogTrigger render={<Button type="button" disabled={disabled} />}>
            <FolderAdd className="size-4" />
            Add a project
          </DialogTrigger>
        ) : (
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
              <FolderAdd />
            </TooltipTrigger>
            <TooltipContent>Add project</TooltipContent>
          </Tooltip>
        )}
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
              <div className="flex items-center gap-2">
                <Input
                  id="project-root"
                  className="flex-1"
                  value={workspaceRoot}
                  onChange={(event) => setWorkspaceRoot(event.target.value)}
                  placeholder="/Users/you/code/my-app"
                  aria-invalid={pathProblem !== null}
                  aria-describedby={pathProblem === null ? undefined : "project-root-problem"}
                />
                <Button type="button" variant="outline" onClick={() => void choose()}>
                  Choose…
                </Button>
              </div>
              {pathProblem === null ? null : (
                <p id="project-root-problem" className="type-micro text-destructive" role="alert">
                  {pathProblem}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!canSubmit}>
                Add project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* A sibling, not a child: two modal dialogs each own their own focus
          trap, and nesting one inside the other's content makes the outer one
          fight the inner for it. Mounted only while it is open, so it seeds
          itself from the field as it stands now and browses nothing until
          someone asks it to — this one lives in the sidebar, on every route. */}
      {picking ? (
        <FolderPickerDialog
          open
          onOpenChange={setPicking}
          initialPath={workspaceRoot}
          onPick={accept}
        />
      ) : null}
    </>
  );
}
