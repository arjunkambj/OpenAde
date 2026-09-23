/**
 * Dispatching the thread lifecycle commands, shared by every surface that
 * offers them.
 *
 * The sidebar row menu and Settings → Archived threads both rename, archive,
 * unarchive and delete threads. They report the outcome the same way — a toast
 * with the decider's reason on a refusal, an optional confirmation on success
 * — and they build the command envelope the same way, so the plumbing lives
 * here once rather than drifting apart between the two.
 */

import { toast } from "sonner";

import { makeCommandId, type ThreadId } from "@OpenAde/contracts/ids";
import type { Command } from "@OpenAde/contracts/orchestration";

import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";

/** The confirmation copy for `thread.delete`: it is durable and has no undo. */
export const THREAD_DELETE_DESCRIPTION =
  "Its transcript, its queue and its turn checkpoints go with it, and the session it is running on is closed. Files in the workspace are left alone.";

/**
 * The envelope every thread command carries. A fresh `commandId` per call:
 * the engine answers a repeated id with the stored receipt, so reusing one
 * would replay the first outcome instead of running the command again.
 */
export const threadCommandBase = (threadId: ThreadId) => ({
  commandId: makeCommandId(),
  createdAt: new Date().toISOString(),
  threadId,
});

/**
 * `send(command, fallback, done?)`: dispatch, toast the refusal (or
 * `fallback` when the decider gave no reason), and toast `done` on success
 * when there is something worth confirming.
 */
export const useThreadCommand = () => {
  const dispatch = useDispatchCommand();
  return async (command: Command, fallback: string, done?: string): Promise<void> => {
    const exit = await dispatch(command);
    if (!isAccepted(exit)) {
      toast.error(rejectionMessage(exit, fallback));
      return;
    }
    if (done !== undefined) {
      toast.success(done);
    }
  };
};
