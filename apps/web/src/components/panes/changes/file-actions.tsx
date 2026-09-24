/**
 * The "…" menu at the end of a Changes file row: copy the file's path, or add
 * a reference to it to the thread's draft, the way the browser pane brings a
 * picked element into the conversation (`appendToDraft`). The draft is where
 * it lands — the person reads and sends it; nothing reaches the agent on its
 * own. Nothing here touches the worktree: reverting a file is not an action
 * the pane offers.
 */

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { toast } from "sonner";

import { appendToDraft } from "@/components/panes/browser/page-to-chat";
import { useKeybindingDispatch } from "@/lib/shortcuts";
import { useComposerDraft } from "@/state/ui";

import { Chat, Copy, MoreHorizontal } from "@honeyicons/react";

/**
 * "Add to chat", split out so the draft is only subscribed to while the menu
 * is open — its content unmounts on close. A row that read the draft itself
 * would re-render every file in the list on each keystroke in the composer.
 */
function AddToChatItem({ threadId, path }: { threadId: string; path: string }) {
  const draft = useComposerDraft(threadId);
  const dispatch = useKeybindingDispatch();
  return (
    <DropdownMenuItem
      onClick={() => {
        draft.setText((current) => appendToDraft(current, `\`${path}\``));
        toast.success("Added the file to your message");
        dispatch("composer.focus");
      }}
    >
      <Chat variant="bold" />
      Add to chat
    </DropdownMenuItem>
  );
}

export function FileActions({ threadId, path }: { threadId: string; path: string }) {
  const copy = () => {
    void navigator.clipboard.writeText(path).then(
      () => toast.success("Copied the path"),
      () => toast.error("Could not copy the path"),
    );
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${path}`} />}
            />
          }
        >
          <MoreHorizontal variant="bold" />
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={copy}>
          <Copy variant="bold" />
          Copy path
        </DropdownMenuItem>
        <AddToChatItem threadId={threadId} path={path} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
