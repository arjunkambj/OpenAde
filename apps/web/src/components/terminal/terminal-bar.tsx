/**
 * The strip the thread's terminal drawer collapses to: the Terminal button and,
 * where the open drawer has its hide chevron, a chevron up — both show the
 * drawer. They fire `terminal.toggle` rather than flipping the open state
 * itself, so a click and the chord take one path — the one that also moves
 * focus into the terminal it just opened. The open drawer hides itself from
 * its own toolbar.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { IconButton } from "@/components/terminal/drawer-parts";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { CommandKbd, useKeybindingDispatch } from "@/lib/shortcuts";
import { ChevronUp, Terminal } from "@honeyicons/react";

export function TerminalBar() {
  const fire = useKeybindingDispatch();
  const show = () => fire(TERMINAL_TOGGLE_COMMAND);
  return (
    <div className="flex h-8 shrink-0 items-center border-t border-border px-2">
      <Tooltip>
        <TooltipTrigger
          render={<Button type="button" variant="ghost" tone="muted" size="xs" onClick={show} />}
        >
          <Terminal variant="bold" />
          Terminal
        </TooltipTrigger>
        <TooltipContent>
          Show terminal
          <CommandKbd command={TERMINAL_TOGGLE_COMMAND} />
        </TooltipContent>
      </Tooltip>
      <div className="ml-auto">
        <IconButton
          label="Show terminal"
          onClick={show}
          hint={<CommandKbd command={TERMINAL_TOGGLE_COMMAND} />}
        >
          <ChevronUp variant="bold" />
        </IconButton>
      </div>
    </div>
  );
}
