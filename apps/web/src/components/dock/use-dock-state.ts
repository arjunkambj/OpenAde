/**
 * The right dock's state for one view — a thread, or the New task page for a
 * project — around what `?pane=` says it shows: every move the user makes,
 * what it remembers this session, the requests to focus the Files search or
 * the launcher's first row, and the dock staying up through its close.
 *
 * The rules are the pure half (`./dock-toggle`); this binds them to the view's
 * `DockMemory` (`@/state/ui`, keyed by `memoryKey`) and its route:
 *
 * - Every user move is remembered (`rememberDockMove`) and navigated to, and
 *   clears any pending focus request, so a later click on a tab does not take
 *   the focus.
 * - Arriving with no `?pane=` reopens what the dock was left on earlier in the
 *   session, and nothing otherwise (`dockArrivalTarget`); closing the dock
 *   forgets it, so this cannot reopen what the user just closed.
 * - Whatever put a tab on screen makes it the one the toggle goes back to
 *   (`noteDockShown`); only the user's own moves are reopened on arrival.
 * - The toggle opens on the last tab, else on the launcher with its first row
 *   focused; the Files key focuses the Files search.
 *
 * It also publishes `dockOpen` while the dock is open.
 */

import * as React from "react";

import { useKeybindingFlag } from "@/lib/shortcuts";
import { usePresence } from "@/lib/use-presence";
import { useDockMemory } from "@/state/ui";

import {
  DOCK_HOME,
  dockArrivalTarget,
  dockToggleTarget,
  noteDockShown,
  rememberDockMove,
  type DockPane,
  type DockTab,
} from "./dock-toggle";

export const useDockState = ({
  memoryKey,
  dockTab,
  navigateDock,
  onUserMove,
}: {
  /** Whose dock memory this is: a thread's id, or a project's key. */
  memoryKey: string;
  /** What `?pane=` says the dock shows; `undefined` when it is closed. */
  dockTab: DockPane | undefined;
  /** Puts `tab` in `?pane=` (`null` closes the dock), replacing the entry. */
  navigateDock: (tab: DockPane | null) => void;
  /** Told of each user move before it is made, from what the dock showed. */
  onUserMove?: (from: DockPane | undefined, to: DockPane | undefined) => void;
}) => {
  const [dockMemory, updateDockMemory] = useDockMemory(memoryKey);

  // Set by the Files key, read once by the Files pane as it mounts; any other
  // move of the dock clears it, so a later click on the tab does not focus.
  const [focusFilesSearch, setFocusFilesSearch] = React.useState(false);
  // The same for the launcher's first row: set only when the user opens the
  // dock onto it, so arriving at a dock left on the launcher (or reloading
  // onto one) leaves the focus where it is.
  const [focusLauncher, setFocusLauncher] = React.useState(false);

  /** Every dock move the user makes: remembered, and noted. */
  const setDockTab = React.useCallback(
    (tab: DockPane | null) => {
      setFocusFilesSearch(false);
      setFocusLauncher(false);
      onUserMove?.(dockTab, tab ?? undefined);
      updateDockMemory((memory) => rememberDockMove(memory, tab));
      navigateDock(tab);
    },
    [dockTab, onUserMove, updateDockMemory, navigateDock],
  );

  const arrival = dockArrivalTarget(dockMemory);
  React.useEffect(() => {
    if (dockTab === undefined && arrival !== undefined) {
      navigateDock(arrival);
    }
  }, [dockTab, navigateDock, arrival]);

  React.useEffect(() => {
    updateDockMemory((memory) => noteDockShown(memory, dockTab));
  }, [dockTab, updateDockMemory]);

  const toggleDock = () => {
    const target = dockToggleTarget(dockTab, dockMemory?.lastTab);
    setDockTab(target);
    setFocusLauncher(target === DOCK_HOME);
  };
  const showDockTab = (tab: DockTab | null, focus = false) => {
    setDockTab(tab);
    setFocusFilesSearch(focus && tab === "files");
  };
  const onFilesSearchFocused = React.useCallback(() => setFocusFilesSearch(false), []);
  const onLauncherFocused = React.useCallback(() => setFocusLauncher(false), []);

  useKeybindingFlag("dockOpen", dockTab !== undefined);

  // The dock stays up through its close, showing the tab it closed on.
  const phase = usePresence(dockTab !== undefined);
  const heldDockTab = React.useRef(dockTab);
  if (dockTab !== undefined) {
    heldDockTab.current = dockTab;
  }
  const shownDockTab = dockTab ?? heldDockTab.current;

  return {
    setDockTab,
    toggleDock,
    showDockTab,
    focusFilesSearch,
    onFilesSearchFocused,
    focusLauncher,
    onLauncherFocused,
    /** The dock's presence, `null` once it has closed. */
    phase,
    /** What the dock shows, held through its close. */
    shownDockTab,
  };
};
