/**
 * The dock's launcher: what `dock.toggle` and the header's dock button open
 * onto when this thread has no tab to go back to (`?pane=home`).
 *
 * A short list, one row per tab — Changes, Browser, Files — each with its
 * icon, its name, a live line of status and its key, so the dock says what is
 * worth opening before it opens anything. The words and the key handling are
 * the pure half, `./launcher`; this reads the atoms they are computed from:
 *
 * - Changes: the thread's `git.status` and working-tree `git.diff` — the same
 *   atoms the Changes tab and the header's git actions read, so nothing is
 *   fetched twice. A workspace git does not track disables the row.
 * - Browser: the thread's open tabs, and whether the agent is driving them.
 * - Files: the directory the Files tab searches.
 *
 * The first enabled row takes focus as the launcher opens, so the keyboard
 * goes on from the key that opened it: the arrows (and Home/End) move between
 * rows, Enter or Space opens one, and a row's first letter — C, B or F —
 * opens it straight away. The tabs' own keys keep working as they always do.
 */

import * as React from "react";

import { useAtomValue } from "@effect/atom-react";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import { agentUsingBrowser } from "@/components/panes/browser/auto-open";
import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { CommandKbd } from "@/lib/shortcuts";
import { getAppAtoms } from "@/state/app-runtime";
import { useThreadTabs } from "@/state/browser-tabs";
import { useConnectionState, useProjects } from "@/state/hooks";

import { DOCK_TAB_META } from "./dock-tab-meta";
import { dockTabs, type DockTab } from "./dock-toggle";
import {
  browserStatus,
  changesStatus,
  filesStatus,
  launcherFocusMove,
  launcherLetterPick,
  readGit,
  type LauncherStatus,
} from "./launcher";

/** Each tab's live status line, from the atoms its tab reads. */
function useLauncherStatuses(snapshot: ThreadDetailSnapshot): Record<DockTab, LauncherStatus> {
  const { gitStatusAtom, gitDiffAtom } = useGitAtoms();
  const connected = useConnectionState().status === "connected";
  const scope = { projectId: snapshot.projectId, threadId: snapshot.threadId };
  // The working tree against HEAD: the Changes tab's "uncommitted" comparison.
  const status = readGit(useAtomValue(gitStatusAtom(scope)));
  const diff = readGit(useAtomValue(gitDiffAtom(scope)));

  const browserResult = useAtomValue(getAppAtoms().browserStateAtom(snapshot.threadId));
  const tabs = useThreadTabs(snapshot.threadId);
  const browserState = AsyncResult.isSuccess(browserResult) ? browserResult.value : null;

  const project = useProjects().find((entry) => entry.projectId === snapshot.projectId);
  const root = snapshot.worktree?.path ?? project?.workspaceRoot ?? null;

  return {
    changes: changesStatus(connected, status, diff),
    browser: browserStatus(tabs.tabs.length, agentUsingBrowser(browserState, tabs)),
    files: filesStatus(root),
  };
}

/** `+12 −3`, each side only when it is not zero. */
function Totals({ status }: { status: LauncherStatus }) {
  const additions = status.additions ?? 0;
  const deletions = status.deletions ?? 0;
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      {additions > 0 ? <span className="text-added">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-removed">−{deletions}</span> : null}
    </span>
  );
}

export function DockLauncher({
  snapshot,
  onPick,
}: {
  snapshot: ThreadDetailSnapshot;
  /** Open this tab. */
  onPick: (tab: DockTab) => void;
}) {
  const statuses = useLauncherStatuses(snapshot);
  const rows = dockTabs.map((tab) => ({
    tab,
    label: DOCK_TAB_META[tab].label,
    disabled: statuses[tab].disabled,
  }));
  const enabled = rows.map((row) => !row.disabled);
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = React.useState(() => Math.max(0, enabled.indexOf(true)));

  const focusRow = (index: number) => {
    setFocusIndex(index);
    buttons.current[index]?.focus();
  };

  // Focus the first enabled row as the launcher opens, and later move focus
  // off a row that turns disabled under it (the Changes row learns only after
  // its status loads that the workspace is not a repository) — but only while
  // the focus is still the launcher's, or was dropped with that row.
  const opened = React.useRef(false);
  const enabledKey = enabled.join();
  React.useEffect(() => {
    const flags = enabledKey.split(",").map((flag) => flag === "true");
    const active = document.activeElement;
    const focusIsOurs =
      !opened.current ||
      active === null ||
      active === document.body ||
      buttons.current.some((button) => button === active);
    opened.current = true;
    if (!focusIsOurs) {
      return;
    }
    const current = buttons.current.findIndex((button) => button === active);
    const target = flags[current] === true ? current : flags.indexOf(true);
    if (target >= 0) {
      setFocusIndex(target);
      buttons.current[target]?.focus();
    }
  }, [enabledKey]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const move = launcherFocusMove(event.key, enabled, focusIndex);
    if (move !== null) {
      event.preventDefault();
      focusRow(move);
      return;
    }
    const picked = launcherLetterPick(event.key, rows);
    if (picked !== null) {
      event.preventDefault();
      onPick(picked);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <p className="px-2 type-micro text-muted-foreground">Open a tab</p>
      <div
        role="menu"
        aria-label="Open a dock tab"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-px"
      >
        {rows.map((row, index) => {
          const meta = DOCK_TAB_META[row.tab];
          const status = statuses[row.tab];
          return (
            <Button
              key={row.tab}
              ref={(button: HTMLButtonElement | null) => {
                buttons.current[index] = button;
              }}
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              tabIndex={index === focusIndex ? 0 : -1}
              disabled={row.disabled}
              aria-keyshortcuts={meta.label.charAt(0)}
              aria-description={status.text}
              onFocus={() => setFocusIndex(index)}
              onClick={() => onPick(row.tab)}
              className="w-full justify-start"
            >
              <meta.icon variant="bold" />
              <span className="shrink-0 text-foreground">{meta.label}</span>
              <span className="ml-1 min-w-0 truncate font-normal text-muted-foreground">
                {status.text}
              </span>
              <Totals status={status} />
              <span className="ml-auto shrink-0">
                <CommandKbd command={meta.command} />
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
