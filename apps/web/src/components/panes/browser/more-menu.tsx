/**
 * The in-app pane's "more" menu for the selected tab: zoom, DevTools, the
 * system browser and the url. Each acts on the tab's webview directly; none
 * is a gesture the server hears, because none moves the page the agent is
 * reading.
 *
 * DevTools opens in its own window beside the shell's bridge debugger — a
 * guest takes both at once. Zoom is Chromium's per-site zoom inside the
 * thread's own partition, so it never reaches the OpenAde window.
 */
import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { toast } from "sonner";

import { getTabView, type WebviewElement } from "@/components/browser-host/tab-views";
import { openExternal } from "@/lib/desktop";
import type { BrowserTab } from "@/state/browser-tabs";
import { canZoom, stepZoom, zoomPercent } from "./zoom";
import {
  Code,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Search,
  ZoomIn,
  ZoomOut,
} from "@honeyicons/react";

const WEB_URL = /^https?:\/\//i;

export interface MoreMenuProps {
  readonly tab: BrowserTab | null;
  /** Sets the tab's zoom level, on the webview and in the tabs atom. */
  readonly onZoom: (level: number) => void;
}

/** Runs a webview method, which throws until the guest's first `dom-ready`. */
const onView = (tab: BrowserTab | null, act: (view: WebviewElement) => void) => {
  const view = tab === null ? null : getTabView(tab.tabId);
  if (view === null) return;
  try {
    act(view);
  } catch {
    // Not ready yet.
  }
};

export function MoreMenu({ tab, onZoom }: MoreMenuProps) {
  const level = tab?.zoomLevel ?? 0;
  const web = tab !== null && WEB_URL.test(tab.url);
  const noPage = tab === null;

  const copy = () => {
    if (tab === null || !web) return;
    void navigator.clipboard.writeText(tab.url).then(
      () => toast.success("Copied the page address"),
      () => toast.error("Could not copy the page address"),
    );
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="More browser actions" />}
            />
          }
        >
          <MoreHorizontal variant="bold" />
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          disabled={noPage || !canZoom(level, "in")}
          onClick={() => onZoom(stepZoom(level, "in"))}
        >
          <ZoomIn variant="bold" />
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={noPage || !canZoom(level, "out")}
          onClick={() => onZoom(stepZoom(level, "out"))}
        >
          <ZoomOut variant="bold" />
          Zoom out
        </DropdownMenuItem>
        <DropdownMenuItem disabled={noPage || level === 0} onClick={() => onZoom(0)}>
          <Search variant="bold" />
          Reset zoom
          <DropdownMenuShortcut>{zoomPercent(level)}%</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={noPage}
          onClick={() => onView(tab, (view) => view.openDevTools())}
        >
          <Code variant="bold" />
          Open DevTools
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!web} onClick={() => tab !== null && openExternal(tab.url)}>
          <ExternalLink variant="bold" />
          Open in browser
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!web} onClick={copy}>
          <Copy variant="bold" />
          Copy address
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
