/**
 * The right dock: a resizable panel with `changes | browser | files` tabs.
 *
 * The dock is a shell — the tab strip, the drag-to-resize edge and the panel
 * chrome live here; what each tab renders is its own concern. The active tab
 * is not component state: it travels in the thread route's `?pane=` search
 * param so a thread reload lands on the same tab ("pane state in atoms and
 * search params"). Width persists through `dockWidthAtom` (localStorage) —
 * that is presentation, not durable state.
 *
 * Under 768px the dock is an overlay over the thread column rather than a
 * second one: two columns in that width leave neither readable, and simply
 * hiding the dock (what this used to do) made the changes, browser and files
 * tabs unreachable on a narrow window with no hint that they existed. The
 * resize edge is the one part that stays behind — there is nothing to resize
 * when the panel is already full width.
 */

import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { BrowserPane } from "@/components/panes/browser/browser-pane";
import { ChangesPane } from "@/components/panes/changes/changes-pane";
import { FilesPane } from "@/components/panes/files/files-pane";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { useConnectionState } from "@/state/hooks";
import { useDockWidth } from "@/state/ui";

const DOCK_TABS = ["changes", "browser", "files"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export const isDockTab = (value: unknown): value is DockTab =>
  typeof value === "string" && (DOCK_TABS as ReadonlyArray<string>).includes(value);

const TAB_META: Record<DockTab, { icon: string; label: string }> = {
  changes: { icon: "hugeicons:git-compare", label: "Changes" },
  browser: { icon: "hugeicons:globe-02", label: "Browser" },
  files: { icon: "hugeicons:folder-01", label: "Files" },
};

/** Drag the left edge to resize; the width atom persists every frame. */
function useDockResize() {
  const [width, setWidth] = useDockWidth();
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (move: PointerEvent) => {
        // The dock sits on the right: dragging left widens it.
        setWidth(startWidth + (startX - move.clientX));
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
  const meta = TAB_META[tab];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab)}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 type-body outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-hover font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon icon={meta.icon} className="size-3.5" />
      {meta.label}
    </button>
  );
}

export function RightDock({
  tab,
  onTabChange,
  snapshot,
}: {
  tab: DockTab;
  onTabChange: (tab: DockTab | null) => void;
  snapshot: ThreadDetailSnapshot;
}) {
  const { width, onPointerDown } = useDockResize();
  const connection = useConnectionState();

  return (
    <aside
      aria-label="Thread dock"
      className={cn(
        // Overlay below md, a sibling column at md and up.
        "absolute inset-0 z-20 flex min-h-0 w-full border-l border-border bg-sidebar",
        "md:relative md:inset-auto md:z-auto md:w-(--dock-width) md:shrink-0",
      )}
      style={{ "--dock-width": `${width}px` } as React.CSSProperties}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize dock"
        onPointerDown={onPointerDown}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize md:block"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
          {DOCK_TABS.map((dockTab) => (
            <DockTabButton
              key={dockTab}
              tab={dockTab}
              active={dockTab === tab}
              onSelect={onTabChange}
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
                  onClick={() => onTabChange(null)}
                />
              }
            >
              <Icon icon="hugeicons:cancel-01" />
            </TooltipTrigger>
            <TooltipContent>Close dock</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "changes" ? <ChangesPane snapshot={snapshot} /> : null}
          {/*
            The browser pane hides rather than unmounts. Unmounting it destroys
            the Electron `<webview>` guest, the agent's next call fails
            `tab_gone`, and the reopen finds no pane to attach to — which
            downgrades the thread to owned Chromium for good. A dock tab switch
            must not cost the thread its live view.
          */}
          <div className={tab === "browser" ? "contents" : "hidden"}>
            <BrowserPane threadId={snapshot.threadId} />
          </div>
          {tab === "files" ? (
            <FilesPane
              projectId={snapshot.projectId}
              connected={connection.status === "connected"}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
