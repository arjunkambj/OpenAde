/**
 * The dock's launcher: what `dock.toggle` and the header's dock button open
 * onto when the thread — or, on the New task page, the project — has no tab
 * to go back to (`?pane=home`).
 *
 * A short list, one row per tab the dock offers (`tabs`) — Changes, Browser,
 * Files for a thread; Changes and Files for a project on the New task page —
 * each with its icon, its name and its key. It reads nothing: no git status, no diff, no
 * browser state. Opening the dock loads nothing until the user picks a tab,
 * and the tab then loads what it shows. The key handling is the pure half,
 * `./launcher`.
 *
 * The first row takes focus when the user opens the dock onto the launcher
 * (`focusFirst`), so the keyboard goes on from the key that opened it: the
 * arrows (and Home/End) move between rows, Enter or Space opens one, and a
 * row's first letter — C, B or F — opens it straight away. The tabs' own keys
 * keep working as they always do. A launcher that shows without being asked
 * for — reopened on arriving at a thread, or reloaded from a `?pane=home`
 * link — leaves the focus where it is.
 */

import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";

import { CommandKbd } from "@/lib/shortcuts";

import { DOCK_TAB_META } from "./dock-tab-meta";
import { dockTabs, type DockTab } from "./dock-toggle";
import { launcherFocusMove, launcherLetterPick } from "./launcher";

export function DockLauncher({
  tabs = dockTabs,
  onPick,
  focusFirst = false,
  onFocused,
}: {
  /** The tabs this dock offers, in order. */
  tabs?: ReadonlyArray<DockTab>;
  /** Open this tab. */
  onPick: (tab: DockTab) => void;
  /** Focus the first row — the user opened the dock onto the launcher. */
  focusFirst?: boolean;
  /** `focusFirst` was acted on, so the request is spent once. */
  onFocused?: () => void;
}) {
  const rows = tabs.map((tab) => ({ tab, label: DOCK_TAB_META[tab].label }));
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = React.useState(0);

  const focusRow = (index: number) => {
    setFocusIndex(index);
    buttons.current[index]?.focus();
  };

  // Focus the first row when the user opened the dock onto the launcher, and
  // only then.
  React.useEffect(() => {
    if (!focusFirst) {
      return;
    }
    setFocusIndex(0);
    buttons.current[0]?.focus();
    onFocused?.();
  }, [focusFirst, onFocused]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const move = launcherFocusMove(event.key, rows.length, focusIndex);
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

  // Centred in the dock, with full-size rows: with nothing else in the
  // panel, the choice is the whole screen, not a list tucked into a corner.
  return (
    <div className="flex h-full items-center justify-center px-6 py-4">
      <div className="flex w-full max-w-72 flex-col gap-2">
        <p className="px-2.5 type-micro text-muted-foreground">Open a tab</p>
        <div
          role="menu"
          aria-label="Open a dock tab"
          aria-orientation="vertical"
          onKeyDown={onKeyDown}
          className="flex flex-col gap-1"
        >
          {rows.map((row, index) => {
            const meta = DOCK_TAB_META[row.tab];
            return (
              <Button
                key={row.tab}
                ref={(button: HTMLButtonElement | null) => {
                  buttons.current[index] = button;
                }}
                type="button"
                role="menuitem"
                variant="ghost"
                size="lg"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-keyshortcuts={row.label.charAt(0)}
                onFocus={() => setFocusIndex(index)}
                onClick={() => onPick(row.tab)}
                className="w-full justify-start"
              >
                <meta.icon variant="bold" />
                <span className="text-foreground">{row.label}</span>
                <span className="ml-auto shrink-0">
                  <CommandKbd command={meta.command} />
                </span>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
