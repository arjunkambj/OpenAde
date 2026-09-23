/**
 * The per-thread overflow menu: rename, archive or unarchive, delete.
 *
 * `thread.rename`, `thread.archive`, `thread.unarchive` and `thread.delete`
 * run through the command union, the decider and the reactors — closing the
 * session, pruning the checkpoints, deleting the staged attachments. This menu
 * and Settings → Archived threads are where the renderer dispatches them, both
 * through `thread-actions.ts`; without them the sidebar grows forever and
 * every one of those cleanup behaviours is unreachable from the product.
 *
 * Delete is behind a confirmation, on the precedent `RestoreCheckpointDialog`
 * set: it is durable and there is no undo. Archive is not — the thread stays,
 * and an archived row offers Unarchive in place of Archive, as the Archived
 * threads settings page does.
 *
 * Both dialogs are siblings of the menu, not children of it: two modal
 * surfaces each own a focus trap, and a menu that is closing while a dialog
 * opens inside it fights the dialog for focus.
 */

import * as React from "react";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { Input } from "@OpenAde/ui/components/input";
import { Label } from "@OpenAde/ui/components/label";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  THREAD_DELETE_DESCRIPTION,
  threadCommandBase,
  useThreadCommand,
} from "@/components/sidebar/thread-actions";
import { Archive as ArchiveIcon, ArchiveUp, Edit, MoreHorizontal, Trash } from "@honeyicons/react";

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
  const send = useThreadCommand();
  const [dialog, setDialog] = React.useState<OpenDialog>(null);

  const base = () => threadCommandBase(thread.threadId);

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
                    aria-label={`Actions for ${thread.title}`}
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
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            <Edit variant="bold" />
            Rename
          </DropdownMenuItem>
          {thread.status === "archived" ? (
            <DropdownMenuItem
              onClick={() =>
                void send(
                  { ...base(), type: "thread.unarchive" },
                  "Thread was not unarchived",
                  "Unarchived",
                )
              }
            >
              <ArchiveUp variant="bold" />
              Unarchive
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                void send(
                  { ...base(), type: "thread.archive" },
                  "Thread was not archived",
                  "Archived",
                )
              }
            >
              <ArchiveIcon variant="bold" />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
            <Trash variant="bold" />
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
        description={THREAD_DELETE_DESCRIPTION}
        confirmLabel="Delete thread"
        onConfirm={() =>
          void send({ ...base(), type: "thread.delete" }, "Thread was not deleted", "Deleted")
        }
      />
    </>
  );
}
