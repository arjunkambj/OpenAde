/**
 * The dock's tab strip: `Changes | Browser | Files` and the close button.
 *
 * A `tablist` in the ARIA sense. Each tab names the one panel below it
 * (`aria-controls`), which names the tab back while a tab is shown; in the
 * launcher no tab is selected, and the panel is the launcher's menu instead.
 * Only one tab is in the Tab order — the selected one, or the first while the
 * launcher shows — and Left/Right move along the strip from the focused tab,
 * wrapping, opening the tab they land on and keeping the focus on it
 * (`adjacentDockTab`).
 *
 * The Changes tab carries the workspace's uncommitted file count from
 * `git.status` as a small badge, hidden at zero or outside a repository.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { Badge } from "@OpenAde/ui/components/badge";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { CommandKbd } from "@/lib/shortcuts";
import { Close as CloseIcon } from "@honeyicons/react";

import { DOCK_TAB_META } from "./dock-tab-meta";
import { adjacentDockTab, dockTabs, isDockTab, type DockPane, type DockTab } from "./dock-toggle";
import { readGit, uncommittedCount } from "./launcher";

/** The ids that tie each tab to the dock's one panel. */
export const dockTabId = (baseId: string, tab: DockTab) => `${baseId}-tab-${tab}`;
export const dockPanelId = (baseId: string) => `${baseId}-panel`;

/** The thread's uncommitted file count, or `null` when there is nothing to show. */
function useUncommittedCount(snapshot: ThreadDetailSnapshot): number | null {
  const { gitStatusAtom } = useGitAtoms();
  const status = readGit(
    useAtomValue(gitStatusAtom({ projectId: snapshot.projectId, threadId: snapshot.threadId })),
  );
  const count = uncommittedCount(status);
  return count === null || count === 0 ? null : count;
}

function DockTabButton({
  baseId,
  tab,
  active,
  focusable,
  count,
  onSelect,
}: {
  baseId: string;
  tab: DockTab;
  active: boolean;
  /** The strip's one Tab stop. */
  focusable: boolean;
  /** A badge beside the label; `null` shows none. */
  count: number | null;
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
            aria-label={
              count === null
                ? undefined
                : `${meta.label}, ${count} uncommitted ${count === 1 ? "file" : "files"}`
            }
            tabIndex={focusable ? 0 : -1}
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
        {count === null ? null : <Badge variant={active ? "outline" : "secondary"}>{count}</Badge>}
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
  snapshot,
  onTabChange,
}: {
  baseId: string;
  pane: DockPane;
  snapshot: ThreadDetailSnapshot;
  onTabChange: (pane: DockPane | null) => void;
}) {
  const count = useUncommittedCount(snapshot);
  const strip = React.useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    // Step from the tab that has the focus: the selected one, or in the
    // launcher the first, which is then the strip's Tab stop.
    const focused = (event.target as HTMLElement)
      .closest("[data-dock-tab]")
      ?.getAttribute("data-dock-tab");
    const next = adjacentDockTab(isDockTab(focused) ? focused : pane, step);
    onTabChange(next);
    strip.current?.querySelector<HTMLElement>(`[data-dock-tab="${next}"]`)?.focus();
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
      <div
        ref={strip}
        role="tablist"
        aria-label="Dock tabs"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex items-center gap-0.5"
      >
        {dockTabs.map((tab, index) => (
          <DockTabButton
            key={tab}
            baseId={baseId}
            tab={tab}
            active={tab === pane}
            focusable={pane === tab || (index === 0 && !isDockTab(pane))}
            count={tab === "changes" ? count : null}
            onSelect={onTabChange}
          />
        ))}
      </div>
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
