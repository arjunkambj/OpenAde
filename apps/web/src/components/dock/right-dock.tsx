/**
 * The right dock: a resizable panel with `changes | browser | files` tabs,
 * and a launcher for when it is open with no tab chosen.
 *
 * The dock is a shell — the tab strip, the drag-to-resize edge and the panel
 * chrome live here; what each tab renders is its own concern. What it shows
 * is not component state: it travels in the thread route's `?pane=` search
 * param — a tab, or `home` for the launcher — so a thread reload lands on the
 * same view ("pane state in atoms and search params"). The rules for where
 * the keys and buttons take it, and what it remembers per thread, are the
 * pure half in `./dock-toggle`. Width persists through `dockWidthAtom`
 * (localStorage) — that is presentation, not durable state.
 *
 * The dock starts closed, and opening it without naming a tab (`dock.toggle`,
 * the header's dock button) goes back to the last tab this thread used this
 * session, else to the launcher (`./dock-launcher`): one row per tab with its
 * live status, so opening the dock never drops the user into a tab they did
 * not ask for. In the launcher the strip shows no tab selected.
 *
 * With less than 640px beside the sidebar, the dock overlays the thread
 * column: two columns in that width leave neither readable, and simply
 * hiding the dock (what this used to do) made the changes, browser and files
 * tabs unreachable on a narrow window with no hint that they existed. The
 * resize edge is the one part that stays behind — there is nothing to resize
 * when the panel is already full width.
 *
 * Each tab has a key (`dock.changes`, `browserPane.toggle`, `dock.files`) and
 * the dock one (`dock.toggle`); `ThreadView` answers them, and the tab and
 * close tooltips show the chords. Opening Files from its key focuses the
 * Files search (`focusFilesSearch`). The Files tab keeps its search, open
 * file and scroll per thread (`@/components/panes/files/files-view`), so it
 * is unmounted like the others when another tab shows and still comes back
 * as it was left.
 *
 * Opening, the dock grows in from the right edge, and closing it shrinks back
 * (`@/lib/use-presence`, which keeps it mounted until it is gone); overlaid on
 * a narrow row, it slides in and out instead. It eases only while it opens or
 * closes, so dragging its edge still tracks the pointer.
 */

import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { BrowserPane } from "@/components/panes/browser/browser-pane";
import { ChangesPane } from "@/components/panes/changes/changes-pane";
import { FilesPane } from "@/components/panes/files/files-pane";
import type { Presence } from "@/lib/use-presence";
import { CommandKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useConnectionState } from "@/state/hooks";
import { Close as CloseIcon } from "@honeyicons/react";
import { DOCK_WIDTH_MAX_FRACTION, THREAD_COLUMN_MIN, useDockWidth } from "@/state/ui";

import { DockLauncher } from "./dock-launcher";
import { DOCK_TAB_META } from "./dock-tab-meta";
import { DOCK_HOME, dockTabs, type DockPane, type DockTab } from "./dock-toggle";

/** Drag the left edge to resize; the width atom persists every frame. */
function useDockResize() {
  const [width, setWidth] = useDockWidth();
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const dock = event.currentTarget.parentElement;
      // Start from what is on screen: the CSS bound may be holding the stored
      // width back on a window narrower than the one it was dragged in.
      const startWidth = dock?.getBoundingClientRect().width ?? width;
      const available = dock?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
      const onMove = (move: PointerEvent) => {
        // The dock sits on the right: dragging left widens it.
        setWidth(startWidth + (startX - move.clientX), available);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth],
  );
  return { width, onPointerDown };
}

function DockTabButton({
  tab,
  active,
  onSelect,
}: {
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
            aria-selected={active}
            variant={active ? "secondary" : "ghost"}
            tone={active ? "default" : "muted"}
            // The Changes toolbar's Compare menu is 28px under it; the tabs
            // match it, so the two rows read as one set of controls.
            className="h-7"
            onClick={() => onSelect(tab)}
          />
        }
      >
        <meta.icon variant="bold" />
        {meta.label}
      </TooltipTrigger>
      <TooltipContent>
        {meta.label}
        <CommandKbd command={meta.command} />
      </TooltipContent>
    </Tooltip>
  );
}

export function RightDock({
  pane,
  phase,
  onPaneChange,
  snapshot,
  focusFilesSearch = false,
  onFilesSearchFocused,
}: {
  pane: DockPane;
  phase: Presence;
  onPaneChange: (pane: DockPane | null) => void;
  snapshot: ThreadDetailSnapshot;
  /** Focus the Files search as the Files tab mounts — set by its key. */
  focusFilesSearch?: boolean;
  onFilesSearchFocused?: () => void;
}) {
  const { width, onPointerDown } = useDockResize();
  const connection = useConnectionState();
  const onPick = React.useCallback((tab: DockTab) => onPaneChange(tab), [onPaneChange]);

  return (
    <aside
      aria-label="Thread dock"
      data-font-scope="sidebar"
      inert={phase === "leaving"}
      className={cn(
        // Split only when the row fits a 360px thread and a 280px dock.
        "absolute inset-0 z-20 flex min-h-0 w-full border-l border-border bg-sidebar [&_svg:not([class*='text-'],[class*='opacity-'])]:opacity-80",
        "@min-[640px]/thread:relative @min-[640px]/thread:inset-auto @min-[640px]/thread:z-auto @min-[640px]/thread:w-(--dock-width) @min-[640px]/thread:shrink-0",
        phase !== "shown" &&
          "overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        phase === "entering" &&
          "starting:translate-x-full @min-[640px]/thread:starting:w-0 @min-[640px]/thread:starting:translate-x-0",
        phase === "leaving" &&
          "translate-x-full @min-[640px]/thread:w-0 @min-[640px]/thread:translate-x-0",
      )}
      style={
        {
          "--dock-width": `min(${width}px, ${DOCK_WIDTH_MAX_FRACTION * 100}%, calc(100% - ${THREAD_COLUMN_MIN}px))`,
        } as React.CSSProperties
      }
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize dock"
        onPointerDown={onPointerDown}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize @min-[640px]/thread:block"
      />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          // While the width eases, hold the content at the dock's floor so it
          // is uncovered rather than squeezed.
          phase !== "shown" && "min-w-70",
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
          {dockTabs.map((dockTab) => (
            <DockTabButton
              key={dockTab}
              tab={dockTab}
              active={dockTab === pane}
              onSelect={onPick}
            />
          ))}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close dock"
                  className="ml-auto"
                  onClick={() => onPaneChange(null)}
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          {pane === DOCK_HOME ? <DockLauncher snapshot={snapshot} onPick={onPick} /> : null}
          {pane === "changes" ? <ChangesPane snapshot={snapshot} /> : null}
          {/*
            Unmounting the pane is safe: its tabs are webviews the browser
            host keeps above the routes, and the pane only marks where the
            selected one goes.
          */}
          {pane === "browser" ? (
            <BrowserPane threadId={snapshot.threadId} projectId={snapshot.projectId} />
          ) : null}
          {pane === "files" ? (
            <FilesPane
              // Per thread: the pane saves its scroll for the thread it was
              // mounted for as it unmounts.
              key={snapshot.threadId}
              projectId={snapshot.projectId}
              threadId={snapshot.threadId}
              connected={connection.status === "connected"}
              focusSearch={focusFilesSearch}
              onSearchFocused={onFilesSearchFocused}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
