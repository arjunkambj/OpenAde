/**
 * The dock launcher's keys, as pure functions.
 *
 * The launcher (`?pane=home`) is what an open dock shows before a tab is
 * chosen: one row per tab — its icon, its name and its key — and nothing
 * else. It reads nothing: no git status, no diff, no browser state, so
 * opening the dock costs no request until the user picks a tab.
 *
 * Rows move with the arrow keys (and Home/End); while the launcher has focus
 * a row's first letter — C, B, F — picks it.
 */

import type { DockTab } from "./dock-toggle";

/**
 * The row focus moves to for `key` from `current`, over `count` rows: arrows
 * step and wrap, Home and End go to the ends. `null` when the key does not
 * move focus.
 */
export const launcherFocusMove = (key: string, count: number, current: number): number | null => {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    default:
      return null;
  }
};

/** The tab a bare letter picks — its label's first letter. */
export const launcherLetterPick = (
  key: string,
  rows: ReadonlyArray<{ readonly tab: DockTab; readonly label: string }>,
): DockTab | null => {
  if (key.length !== 1) {
    return null;
  }
  const letter = key.toLowerCase();
  return rows.find((candidate) => candidate.label.toLowerCase().startsWith(letter))?.tab ?? null;
};
