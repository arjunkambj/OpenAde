/**
 * The terminal and dock toggles at the right end of a header — the thread's
 * (`./thread-header`) and the New task page's (`./start-thread-header`).
 *
 * The terminal button fires `terminal.toggle` rather than flipping the state,
 * so the click also moves focus into the terminal it opens, as the chord does;
 * whichever drawer is mounted (a thread's or the project's,
 * `@/components/terminal/owned-terminal`) answers it. It shows as pressed
 * while the drawer of `terminalKey` — its owner's `terminalOwnerKey` — is
 * open. The dock button is the view's own dock toggle.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import type { DockPane } from "@/components/dock/dock-toggle";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { CommandKbd, useKeybindingDispatch } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useTerminalOpen } from "@/state/terminal-ui";
import { LayoutAlignBottom, LayoutAlignRight } from "@honeyicons/react";

export function HeaderToggles({
  terminalKey,
  dockTab,
  onDockToggle,
}: {
  /** Whose terminal drawer the button reflects: a thread's id, or a project's key. */
  terminalKey: string;
  /** What the dock shows — a tab or its launcher — or `undefined` when closed. */
  dockTab: DockPane | undefined;
  onDockToggle: () => void;
}) {
  const fire = useKeybindingDispatch();
  const [terminalOpen] = useTerminalOpen(terminalKey);

  return (
    <span className="inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
              aria-pressed={terminalOpen}
              onClick={() => fire(TERMINAL_TOGGLE_COMMAND)}
            />
          }
        >
          <LayoutAlignBottom variant="bold" className={cn(terminalOpen && "text-foreground")} />
        </TooltipTrigger>
        <TooltipContent>
          {terminalOpen ? "Hide terminal" : "Show terminal"}
          <CommandKbd command={TERMINAL_TOGGLE_COMMAND} />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={dockTab === undefined ? "Open dock" : "Close dock"}
              aria-pressed={dockTab !== undefined}
              onClick={onDockToggle}
            />
          }
        >
          <LayoutAlignRight
            variant="bold"
            className={cn(dockTab !== undefined && "text-foreground")}
          />
        </TooltipTrigger>
        <TooltipContent>
          {dockTab === undefined ? "Open dock" : "Close dock"}
          <CommandKbd command="dock.toggle" />
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
