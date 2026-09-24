/**
 * The timeline's restore confirmation: a controlled dialog the caller opens
 * from its own button ("Restore to here" under a user message). Restoring
 * rewrites the worktree, so it never happens on a single click; only this
 * dialog's Restore button dispatches `thread.checkpoint.restore`.
 *
 * It reports the same two failures the Changes pane's dialog does, in the
 * dialog, which stays open so they can be read: the command rejected up front
 * (a turn started meanwhile, an unknown checkpoint) with the receipt's reason,
 * and a dispatch that never reached the server. An accepted receipt means
 * "queued": the checkpoint reactor does the git work after the event is
 * durable, and a failure there lands in the timeline as an error, so the copy
 * says so instead of implying the files are already back.
 *
 * The dispatch goes through the client runtime in context, so on the fixture
 * page it reaches the fixture's decider. The body mounts with the popup, only
 * while the dialog is open, which also clears the last error on the next open.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId, type ThreadId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import { Button } from "@OpenAde/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@OpenAde/ui/components/dialog";
import * as Exit from "effect/Exit";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";

export interface RestoreCheckpointDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId;
  readonly checkpoint: CheckpointSummary;
  readonly title: string;
  readonly description: string;
  /** A caveat under the description, e.g. that later turns are undone too. */
  readonly note?: string | undefined;
  /** Non-null keeps Restore disabled and says why: a turn started meanwhile. */
  readonly blockedReason: string | null;
}

function RestoreBody({
  onOpenChange,
  threadId,
  checkpoint,
  title,
  description,
  note,
  blockedReason,
}: Omit<RestoreCheckpointDialogProps, "open">) {
  const dispatch = useAtomSet(useClientRuntime().dispatchAtom, { mode: "promiseExit" });
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const restore = async () => {
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
      onOpenChange(false);
      return;
    }
    setError(
      Exit.isSuccess(exit)
        ? (exit.value.reason ?? "The server rejected the restore.")
        : "Could not reach the server.",
    );
  };

  const problem = error ?? blockedReason;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {note === undefined ? null : <p className="type-body text-muted-foreground">{note}</p>}
      <p className="type-micro text-muted-foreground">
        The restore is queued on the thread; if git refuses it, the failure appears in the timeline
        as an error.
      </p>
      {problem === null ? null : (
        <p role="alert" className="type-body text-destructive">
          {problem}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={pending || blockedReason !== null}
          onClick={() => void restore()}
        >
          {pending ? "Restoring…" : "Restore"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function RestoreCheckpointDialog({ open, ...props }: RestoreCheckpointDialogProps) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <RestoreBody {...props} />
      </DialogContent>
    </Dialog>
  );
}
