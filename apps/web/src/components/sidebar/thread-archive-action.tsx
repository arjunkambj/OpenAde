/**
 * The thread row's hover quick action: archive in one click, beside the
 * overflow menu that also offers it. Archiving is not destructive — the thread
 * stays, and archiving again is refused rather than compounded — so it needs
 * no confirmation, and an archived row simply does not show the action.
 *
 * The dispatch is the menu's own, from `./thread-actions`: the same command,
 * the same fallback and the same toasts.
 */

import { SidebarMenuAction } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { Archive } from "@honeyicons/react";

export function ThreadArchiveAction({ thread }: { readonly thread: ThreadSummary }) {
  const send = useThreadCommand();

  if (thread.status === "archived") {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuAction
            showOnHover
            aria-label={`Archive ${thread.title}`}
            className="right-8"
            onClick={() =>
              void send(
                { ...threadCommandBase(thread.threadId), type: "thread.archive" },
                "Thread was not archived",
                "Archived",
              )
            }
          />
        }
      >
        <Archive />
      </TooltipTrigger>
      <TooltipContent>Archive</TooltipContent>
    </Tooltip>
  );
}
