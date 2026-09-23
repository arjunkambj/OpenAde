/**
 * The thread header's terminal button. It fires `terminal.toggle` rather than
 * flipping the open state itself, so a click and the chord take one path —
 * the one that also moves focus into the terminal it just opened.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { SHORTCUT_COMMANDS, ShortcutKbd, useKeybindingDispatch } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useTerminalOpen } from "@/state/terminal-ui";
import { Terminal } from "@honeyicons/react";

export function TerminalToggleButton({ threadId }: { threadId: ThreadId }) {
  const [open] = useTerminalOpen(threadId);
  const fire = useKeybindingDispatch();
  return (
    <span className="inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle terminal"
              aria-pressed={open}
              onClick={() => fire(SHORTCUT_COMMANDS.terminal)}
            />
          }
        >
          <Terminal className={cn(open && "text-foreground")} />
        </TooltipTrigger>
        <TooltipContent>
          Toggle terminal
          <ShortcutKbd id="terminal" />
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
