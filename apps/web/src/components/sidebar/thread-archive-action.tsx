/**
 * The thread row's hover quick action: archive in one click, beside the
 * overflow menu that also offers it. Archiving is not destructive — the thread
 * stays, and archiving again is refused rather than compounded — so it needs
 * no confirmation, and an archived row simply does not show the action.
 */

import { toast } from "sonner";

import { SidebarMenuAction } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";
import { Archive } from "@honeyicons/react";

export function ThreadArchiveAction({ thread }: { readonly thread: ThreadSummary }) {
  const dispatch = useDispatchCommand();

  if (thread.status === "archived") {
    return null;
  }

  // This dispatch mirrors the archive item in `./thread-menu` — same command,
  // same fallback and toasts. Merge the two into one helper when the archive
  // and unarchive rework there lands.
  const archive = async () => {
    const exit = await dispatch({
      type: "thread.archive",
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
    });
    if (!isAccepted(exit)) {
      toast.error(rejectionMessage(exit, "Thread was not archived"));
      return;
    }
    toast.success("Archived");
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuAction
            showOnHover
            aria-label={`Archive ${thread.title}`}
            className="right-8"
            onClick={() => void archive()}
          />
        }
      >
        <Archive />
      </TooltipTrigger>
      <TooltipContent>Archive</TooltipContent>
    </Tooltip>
  );
}
