/**
 * The "delete this thread?" confirmation the sidebar row menu and Settings →
 * Archived threads share, and the second confirmation a forced worktree
 * removal needs.
 *
 * A thread with its own worktree gets one more choice: a checkbox, checked by
 * default, to remove that worktree too. Its branch is never deleted, so the
 * commits on it survive either way — the copy says so. The order and the
 * guards (the removal only follows an accepted delete, and a tree holding
 * uncommitted work is never forced without asking again) are
 * `./delete-thread`; `./use-delete-thread` binds them.
 */

import { useAtom } from "@effect/atom-react";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { THREAD_DELETE_DESCRIPTION } from "@/components/sidebar/thread-actions";
import { dequeueForceRemoval } from "@/components/sidebar/delete-thread";
import { forceRemovalRequestsAtom } from "@/components/sidebar/use-delete-thread";

export function DeleteThreadDialog({
  thread,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** `null` while nothing is pending; the dialog is closed then anyway. */
  readonly thread: ThreadSummary | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (thread: ThreadSummary, removeWorktree: boolean) => void;
}) {
  const [removeWorktree, setRemoveWorktree] = React.useState(true);
  // Checked again on every opening: the choice is per deletion, not sticky.
  React.useEffect(() => {
    if (open) {
      setRemoveWorktree(true);
    }
  }, [open]);

  const worktree = thread?.worktree;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {thread === null ? "Delete thread?" : `Delete ${thread.title}?`}
          </DialogTitle>
          <DialogDescription>{THREAD_DELETE_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {worktree === undefined ? null : (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={removeWorktree}
              onCheckedChange={(checked) => setRemoveWorktree(checked === true)}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="break-all">Also remove the worktree at {worktree.path}</span>
              <span className="text-xs text-muted-foreground">
                The branch {worktree.branch} is kept, along with its commits. Uncommitted work stops
                the removal and asks you first.
              </span>
            </span>
          </label>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
              if (thread !== null) {
                onConfirm(thread, worktree !== undefined && removeWorktree);
              }
            }}
          >
            Delete thread
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The forced removal's confirmation, mounted once above the routes: the row
 * that started the delete is gone by the time the user picks "Remove anyway".
 * Requests are answered in the order they were made; each gets a dialog of its
 * own (keyed by its worktree), so the next one opens as the last one closes.
 */
export function WorktreeForceRemovalHost() {
  const [queue, setQueue] = useAtom(forceRemovalRequestsAtom);
  const request = queue[0] ?? null;
  // The copy outlives the request by the dialog's closing animation.
  const shown = React.useRef(request);
  if (request !== null) {
    shown.current = request;
  }
  const worktree = shown.current?.worktree;

  return (
    <ConfirmDialog
      key={worktree?.path}
      open={request !== null}
      onOpenChange={(next) => {
        if (next || request === null) {
          return;
        }
        setQueue((current) => dequeueForceRemoval(current, request));
        // ConfirmDialog closes before it confirms, in the same handler. The
        // answer is first-wins, so a cancel is answered after that handler
        // has run and a confirm's `true` has already landed.
        queueMicrotask(() => request.answer(false));
      }}
      title="Remove the worktree anyway?"
      description={
        worktree === undefined
          ? ""
          : `The uncommitted and untracked changes in ${worktree.path} will be lost. The branch ${worktree.branch} is kept, with its commits.`
      }
      confirmLabel="Remove anyway"
      onConfirm={() => request?.answer(true)}
    />
  );
}
