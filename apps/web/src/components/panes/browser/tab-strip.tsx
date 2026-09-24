/**
 * The in-app pane's tab strip: one entry per tab of the thread, in strip
 * order, with a close button each and a new-tab button at the end.
 *
 * Every tab here is a webview the browser host renders; the strip only edits
 * the tabs atom. A popup lands right after the tab that opened it, and a tab
 * the agent opens (`browser_tabs new`, `Target.createTarget`) arrives through
 * the host the same way and is selected — as is one the agent brings to the
 * front. Selecting a tab here moves the pane, not the agent: agent-browser
 * stays pinned to whichever tab it was driving.
 *
 * The stock shadcn tabs cannot hold a close button inside a trigger (a
 * button in a button), so each entry is a pair of stock Buttons.
 */
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { tabLabel, type BrowserTab, type ThreadTabs } from "@/state/browser-tabs";
import { Add, Close, Globe, Spinner } from "@honeyicons/react";

export interface TabStripProps {
  readonly tabs: ThreadTabs;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onNew: () => void;
}

/** The page's icon, a spinner while it loads, or a globe. */
function TabIcon({ tab }: { readonly tab: BrowserTab }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.loading) return <Spinner variant="bold" className="animate-spin" />;
  if (tab.favicon !== null && broken !== tab.favicon) {
    return (
      <img
        src={tab.favicon}
        alt=""
        referrerPolicy="no-referrer"
        className="size-3 shrink-0"
        onError={() => setBroken(tab.favicon)}
      />
    );
  }
  return <Globe variant="bold" />;
}

export function TabStrip({ tabs, onSelect, onClose, onNew }: TabStripProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2 pt-1.5">
      <div role="tablist" aria-label="Browser tabs" className="flex min-w-0 items-center gap-1">
        {tabs.tabs.map((tab) => {
          const selected = tab.tabId === tabs.selected;
          const label = tabLabel(tab);
          return (
            <div key={tab.tabId} className="flex max-w-48 min-w-0 shrink items-center">
              <Button
                type="button"
                role="tab"
                aria-selected={selected}
                variant={selected ? "secondary" : "ghost"}
                tone={selected ? "default" : "muted"}
                size="xs"
                title={tab.url === "" ? label : `${label}\n${tab.url}`}
                className="min-w-0 shrink justify-start"
                onClick={() => onSelect(tab.tabId)}
              >
                <TabIcon tab={tab} />
                <span className="truncate">{label}</span>
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      tone="muted"
                      size="icon-xs"
                      aria-label={`Close ${label}`}
                      onClick={() => onClose(tab.tabId)}
                    />
                  }
                >
                  <Close variant="bold" />
                </TooltipTrigger>
                <TooltipContent>Close tab</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-xs"
              aria-label="New tab"
              onClick={onNew}
            />
          }
        >
          <Add variant="bold" />
        </TooltipTrigger>
        <TooltipContent>New tab</TooltipContent>
      </Tooltip>
    </div>
  );
}
