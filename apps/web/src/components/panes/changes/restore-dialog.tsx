/**
 * Restoring a checkpoint rewrites the worktree, so it never happens on a
 * single click: the button opens this dialog, and only its Restore button
 * dispatches `thread.checkpoint.restore`.
 *
 * Two kinds of failure, both reported here rather than swallowed:
 *
 * - The command is rejected up front — a running turn, an unknown checkpoint.
 *   The receipt carries the reason and it is shown in the dialog, which stays
 *   open so the user can read it.
 * - The dispatch never reaches the server. Same place, generic message.
 *
 * The git work itself runs in the server's checkpoint reactor after the event
 * is durable, so an accepted receipt means "queued", not "done" — a failure
 * there lands in the thread timeline as an error. The dialog says so instead
 * of implying the files are already back, and `onAccepted` is named for what
 * actually happened: the pane waits for the thread to advance before it
 * refetches, because a refetch on the receipt would read the old worktree.
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
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { ThreadId } from "@OpenAde/contracts/ids";
import * as Exit from "effect/Exit";

import { useDispatchCommand } from "@/state/hooks";
import { Undo } from "@honeyicons/react";

export function RestoreCheckpointDialog({
  threadId,
  checkpoint,
  label,
  disabledReason,
  onAccepted,
}: {
  threadId: ThreadId;
  checkpoint: CheckpointSummary | null;
  label: string;
  /** Non-null disables the trigger and explains why on hover. */
  disabledReason: string | null;
  /** The server took the restore order; the git work has not run yet. */
  onAccepted: () => void;
}) {
  const dispatch = useDispatchCommand();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const disabled = disabledReason !== null || checkpoint === null;

  const restore = async () => {
    if (checkpoint === null) {
      return;
    }
    setPending(true);
    setError(null);
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.checkpoint.restore",
      threadId,
      checkpointId: checkpoint.checkpointId,
    });
    setPending(false);
    if (Exit.isSuccess(exit) && exit.value.status === "accepted") {
      setOpen(false);
      onAccepted();
      return;
    }
    setError(
      Exit.isSuccess(exit)
        ? (exit.value.reason ?? "The server rejected the restore.")
        : "Could not reach the server.",
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
        }
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={disabledReason ?? `Restore the worktree to ${label}`}
        onClick={() => setOpen(true)}
      >
        <Undo />
        Restore
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {label}?</DialogTitle>
          <DialogDescription>
            Every tracked file in the workspace goes back to how this turn left it, and files
            created since are removed. Uncommitted work that is not in a checkpoint is lost.
          </DialogDescription>
        </DialogHeader>
        <p className="type-micro text-muted-foreground">
          The restore is queued on the thread; if git refuses it, the failure appears in the
          timeline as an error.
        </p>
        {error === null ? null : (
          <p role="alert" className="type-body text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={() => void restore()}>
            {pending ? "Restoring…" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
