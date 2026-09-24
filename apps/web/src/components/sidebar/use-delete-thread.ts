/**
 * The renderer's side of `./delete-thread`: binds its steps to the thread
 * command, the worktree remove and the toasts.
 *
 * The flow outlives the surface that started it. A sidebar row disappears the
 * moment its thread is deleted, so the second confirmation a forced removal
 * needs cannot be a dialog inside that row: the request joins
 * `forceRemovalRequestsAtom`, and `WorktreeForceRemovalHost`, mounted once
 * above the routes, shows them one after another. The remove is a one-shot
 * call on the app's registry, not tied to the row, so it finishes after the
 * row is gone — and a second delete started meanwhile runs beside it instead
 * of interrupting it.
 */

import { useAtomSet } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { toast } from "sonner";

import type { ThreadWorktree } from "@OpenAde/contracts/git";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { useGitCommands } from "@/components/panes/changes/git-atoms";
import {
  deleteThread,
  enqueueForceRemoval,
  worktreeRemovalOf,
  worktreeRemovedMessage,
  type ForceRemovalRequest,
} from "@/components/sidebar/delete-thread";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";

/** Forced removals waiting on their confirmation, shown one at a time in order. */
export const forceRemovalRequestsAtom = Atom.keepAlive(
  Atom.make<ReadonlyArray<ForceRemovalRequest>>([]),
);

/** `remove(thread, alsoRemoveWorktree)` — see `./delete-thread` for the order and the guards. */
export const useDeleteThread = () => {
  const send = useThreadCommand();
  const { worktreeRemove: removeWorktree } = useGitCommands();
  const setForceRequests = useAtomSet(forceRemovalRequestsAtom);

  /**
   * The server's refusal, with "Remove anyway". The toast stays until it is
   * answered or dismissed: once the thread is gone nothing else in the app
   * offers to remove its worktree.
   */
  const offerForce = (worktree: ThreadWorktree, message: string) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (confirmed: boolean) => {
        if (!settled) {
          settled = true;
          resolve(confirmed);
        }
      };
      toast.error("The worktree was kept", {
        description: message,
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        // sonner runs the action before it removes the toast, and removing it
        // that way does not call `onDismiss`, so the answer is the dialog's.
        action: {
          label: "Remove anyway",
          onClick: () =>
            setForceRequests((queue) => enqueueForceRemoval(queue, { worktree, answer: settle })),
        },
        onDismiss: () => settle(false),
        onAutoClose: () => settle(false),
      });
    });

  return (thread: ThreadSummary, alsoRemoveWorktree: boolean) =>
    deleteThread(thread, alsoRemoveWorktree, {
      deleteThread: () =>
        send(
          { type: "thread.delete", ...threadCommandBase(thread.threadId) },
          "Thread was not deleted",
          "Deleted",
        ),
      removeWorktree: async (force) => {
        const worktree = thread.worktree;
        if (worktree === undefined) {
          return { _tag: "removed" };
        }
        return worktreeRemovalOf(
          await removeWorktree({ projectId: thread.projectId, path: worktree.path, force }),
        );
      },
      offerForce: (message) =>
        thread.worktree === undefined
          ? Promise.resolve(false)
          : offerForce(thread.worktree, message),
      onRemoved: (worktree) => toast.success(worktreeRemovedMessage(worktree)),
      onRemoveFailed: (message) => toast.error(`The worktree was not removed: ${message}`),
    });
};
