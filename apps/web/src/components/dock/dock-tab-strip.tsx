/**
 * The dock's top row: the tab strip and the close button.
 *
 * The strip shows only once a tab is open. The launcher already lists every
 * tab, so while it shows, the row holds the close button and nothing else. Once open, the tabs are icons — the name and the key are in
 * each tab's tooltip and accessible name — so the row stays quiet and the
 * pane below has the room.
 *
 * A `tablist` in the ARIA sense: each tab names the one panel below it
 * (`aria-controls`), a `tabpanel` that names the selected tab back. Only the
 * selected tab is in the Tab order, and Left/Right move along the strip from
 * the focused tab, wrapping, opening the tab they land on and keeping the
 * focus on it (`adjacentDockTab`).
 *
 * The strip reads nothing of its own: a tab's content loads when it opens.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { CommandKbd } from "@/lib/shortcuts";
import { Close as CloseIcon } from "@honeyicons/react";

import { DOCK_TAB_META } from "./dock-tab-meta";
import { adjacentDockTab, dockTabs, isDockTab, type DockPane, type DockTab } from "./dock-toggle";

/** The ids that tie each tab to the dock's one panel. */
export const dockTabId = (baseId: string, tab: DockTab) => `${baseId}-tab-${tab}`;
export const dockPanelId = (baseId: string) => `${baseId}-panel`;

function DockTabButton({
  baseId,
  tab,
  active,
  onSelect,
}: {
  baseId: string;
  tab: DockTab;
  active: boolean;
  onSelect: (tab: DockTab) => void;
}) {
  const meta = DOCK_TAB_META[tab];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            role="tab"
            id={dockTabId(baseId, tab)}
            data-dock-tab={tab}
            aria-selected={active}
            aria-controls={dockPanelId(baseId)}
            aria-label={meta.label}
            tabIndex={active ? 0 : -1}
            variant={active ? "secondary" : "ghost"}
            tone={active ? "default" : "muted"}
            size="icon-sm"
            onClick={() => onSelect(tab)}
          />
        }
      >
        <meta.icon variant="bold" />
      </TooltipTrigger>
      <TooltipContent>
        {meta.label}
        <CommandKbd command={meta.command} />
      </TooltipContent>
    </Tooltip>
  );
}

export function DockTabStrip({
  baseId,
  pane,
  onTabChange,
}: {
  baseId: string;
  pane: DockPane;
  onTabChange: (pane: DockPane | null) => void;
}) {
  const strip = React.useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    // Step from the tab that has the focus, which the keys may have moved
    // ahead of the route.
    const focused = (event.target as HTMLElement)
      .closest("[data-dock-tab]")
      ?.getAttribute("data-dock-tab");
    const next = adjacentDockTab(isDockTab(focused) ? focused : pane, step);
    onTabChange(next);
    strip.current?.querySelector<HTMLElement>(`[data-dock-tab="${next}"]`)?.focus();
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
      {isDockTab(pane) ? (
        <div
          ref={strip}
          role="tablist"
          aria-label="Dock tabs"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex items-center gap-0.5"
        >
          {dockTabs.map((tab) => (
            <DockTabButton
              key={tab}
              baseId={baseId}
              tab={tab}
              active={tab === pane}
              onSelect={onTabChange}
            />
          ))}
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close dock"
              className="ml-auto"
              onClick={() => onTabChange(null)}
            />
          }
        >
          <CloseIcon variant="bold" />
        </TooltipTrigger>
        <TooltipContent>
          Close dock
          <CommandKbd command="dock.toggle" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
