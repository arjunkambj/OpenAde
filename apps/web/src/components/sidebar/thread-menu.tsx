/**
 * The per-thread overflow menu: rename, archive, delete.
 *
 * `thread.rename`, `thread.archive` and `thread.delete` run through the
 * command union, the decider and the reactors — closing the session, pruning
 * the checkpoints, deleting the staged attachments. This menu is the only
 * place the renderer dispatches them; without it the sidebar grows forever and
 * every one of those cleanup behaviours is unreachable from the product.
 *
 * Delete is behind a confirmation, on the precedent `RestoreCheckpointDialog`
 * set: it is durable and there is no undo. Archive is not — the thread stays,
 * and archiving again is refused rather than compounded.
 *
 * Both dialogs are siblings of the menu, not children of it: two modal
 * surfaces each own a focus trap, and a menu that is closing while a dialog
 * opens inside it fights the dialog for focus.
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
} from "@OpenAde/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { Input } from "@OpenAde/ui/components/input";
import { Label } from "@OpenAde/ui/components/label";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";
import { Archive as ArchiveIcon, Edit, MoreHorizontal, Trash } from "@honeyicons/react";

/** Which of the two dialogs this row currently has open. */
type OpenDialog = "rename" | "delete" | null;

function RenameThreadDialog({
  thread,
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly thread: ThreadSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = React.useState(thread.title);
  // Seeded per opening, not once: the thread may have been renamed by the
  // connector's own title inference since this row last mounted.
  React.useEffect(() => {
    if (open) {
      setTitle(thread.title);
    }
  }, [open, thread.title]);

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== thread.title;

  const submit = () => {
    if (canSubmit) {
      onOpenChange(false);
      onSubmit(trimmed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription>
            The title is yours from now on — the connector stops inferring one for this thread.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="thread-title">Title</Label>
            <Input
              id="thread-title"
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              // Explicit rather than leaning on the form's implicit submission:
              // this dialog is one field, Enter is the obvious way out of it,
              // and it should not depend on how a portalled popup happens to
              // route the key.
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ThreadRowMenu({ thread }: { readonly thread: ThreadSummary }) {
  const dispatch = useDispatchCommand();
  const [dialog, setDialog] = React.useState<OpenDialog>(null);

  const send = async (command: Parameters<typeof dispatch>[0], fallback: string, done?: string) => {
    const exit = await dispatch(command);
    if (!isAccepted(exit)) {
      toast.error(rejectionMessage(exit, fallback));
      return;
    }
    if (done !== undefined) {
      toast.success(done);
    }
  };

  const base = () => ({
    commandId: makeCommandId(),
    createdAt: new Date().toISOString(),
    threadId: thread.threadId,
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${thread.title}`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            <Edit />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={thread.status === "archived"}
            onClick={() =>
              void send(
                { ...base(), type: "thread.archive" },
                "Thread was not archived",
                "Archived",
              )
            }
          >
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
            <Trash />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameThreadDialog
        thread={thread}
        open={dialog === "rename"}
        onOpenChange={(next) => setDialog(next ? "rename" : null)}
        onSubmit={(title) =>
          void send({ ...base(), type: "thread.rename", title }, "Thread was not renamed")
        }
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(next) => setDialog(next ? "delete" : null)}
        title={`Delete ${thread.title}?`}
        description="Its transcript, its queue and its turn checkpoints go with it, and the session it is running on is closed. Files in the workspace are left alone."
        confirmLabel="Delete thread"
        onConfirm={() =>
          void send({ ...base(), type: "thread.delete" }, "Thread was not deleted", "Deleted")
        }
      />
    </>
  );
}
