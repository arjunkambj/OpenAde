/**
 * The strip the thread's terminal drawer collapses to: one button that shows
 * the drawer. It fires `terminal.toggle` rather than flipping the open state
 * itself, so a click and the chord take one path — the one that also moves
 * focus into the terminal it just opened. The open drawer hides itself from
 * its own toolbar.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { SHORTCUT_COMMANDS, ShortcutKbd, useKeybindingDispatch } from "@/lib/shortcuts";
import { Terminal } from "@honeyicons/react";

export function TerminalBar() {
  const fire = useKeybindingDispatch();
  return (
    <div className="flex h-8 shrink-0 items-center border-t border-border px-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="xs"
              onClick={() => fire(SHORTCUT_COMMANDS.terminal)}
            />
          }
        >
          <Terminal variant="bold" />
          Terminal
        </TooltipTrigger>
        <TooltipContent>
          Show terminal
          <ShortcutKbd id="terminal" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
