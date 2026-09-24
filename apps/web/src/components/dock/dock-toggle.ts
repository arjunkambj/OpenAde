/**
 * What the right dock shows, and where its keys and buttons take it — the pure
 * half of the dock, tested without a DOM.
 *
 * The dock is either closed (`?pane=` absent), open on one of its tabs
 * (`changes | browser | files`), or open with no tab chosen yet: the
 * launcher, `?pane=home`, a short list of the three tabs with a live line of
 * status each. `DockPane` is that open state; `DockTab` is only the tabs.
 *
 * The dock starts closed. Nothing about it survives a relaunch: a thread
 * reached with no `?pane=` (a sidebar link, a fresh start) opens with the
 * dock shut, unless this session already left that thread's dock open —
 * `DockMemory`, kept per thread in memory only (`@/state/ui`).
 *
 * - `dock.toggle` (and the header's dock button) closes an open dock, and
 *   opens a closed one on the last tab used in this thread this session,
 *   else on the launcher (`dockToggleTarget`).
 * - `dock.changes`, `dock.files` and `browserPane.toggle` open their tab,
 *   from a closed dock, the launcher or another tab, or close the dock when
 *   it is already showing that tab (`dockTabTarget`).
 * - A thread the user left with its dock open reopens on what it showed
 *   (`dockArrivalTarget`); closing the dock forgets that, so arriving can
 *   never reopen what was just closed. The last tab used is kept apart from
 *   it (`lastTab`) so the toggle can still go back to it after a close.
 */

const DOCK_TABS = ["changes", "browser", "files"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

/** The tabs, in strip order. */
export const dockTabs: ReadonlyArray<DockTab> = DOCK_TABS;

/** The launcher: the dock open with no tab chosen. */
export const DOCK_HOME = "home";

/** Everything an open dock can show: a tab, or the launcher. */
export type DockPane = DockTab | typeof DOCK_HOME;

export const isDockTab = (value: unknown): value is DockTab =>
  typeof value === "string" && (DOCK_TABS as ReadonlyArray<string>).includes(value);

/** What `?pane=` may carry; anything else reads as a closed dock. */
export const isDockPane = (value: unknown): value is DockPane =>
  value === DOCK_HOME || isDockTab(value);

export const dockToggleTarget = (
  open: DockPane | undefined,
  lastTab: DockTab | undefined,
): DockPane | null => (open !== undefined ? null : (lastTab ?? DOCK_HOME));

export const dockTabTarget = (open: DockPane | undefined, tab: DockTab): DockTab | null =>
  open === tab ? null : tab;

/**
 * One thread's dock this session. `shown` is what the user left it on, and is
 * gone once they close it; `lastTab` is the last tab shown at all, and stays.
 */
export interface DockMemory {
  readonly shown?: DockPane | undefined;
  readonly lastTab?: DockTab | undefined;
}

/** The user moved the dock to `pane` (`null` closes it). */
export const rememberDockMove = (
  memory: DockMemory | undefined,
  pane: DockPane | null,
): DockMemory => ({
  shown: pane ?? undefined,
  lastTab: isDockTab(pane) ? pane : memory?.lastTab,
});

/**
 * The dock is showing `pane`, whoever put it there — a link to a turn's
 * changes, the browser opening itself for the agent. Only the last tab is
 * noted: reopening on arrival is for what the user chose.
 */
export const noteDockShown = (
  memory: DockMemory | undefined,
  pane: DockPane | undefined,
): DockMemory | undefined =>
  isDockTab(pane) && memory?.lastTab !== pane ? { ...memory, lastTab: pane } : memory;

/** Where arriving at a thread with no `?pane=` puts its dock; `undefined` leaves it shut. */
export const dockArrivalTarget = (memory: DockMemory | undefined): DockPane | undefined =>
  memory?.shown;

/** The tab `step` places from `from` along the strip, wrapping at either end. */
export const adjacentDockTab = (from: DockPane, step: 1 | -1): DockTab => {
  const index = isDockTab(from) ? DOCK_TABS.indexOf(from) : step === 1 ? -1 : 0;
  return DOCK_TABS[(index + step + DOCK_TABS.length) % DOCK_TABS.length] as DockTab;
};
