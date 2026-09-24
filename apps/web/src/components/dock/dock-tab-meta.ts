/**
 * What each dock tab is called, its icon, and the key that opens it — shared
 * by the tab strip, the launcher's rows and their tooltips, so the three
 * never drift apart.
 */

import { type HoneyIcon, Folder, GitDiff, Globe } from "@honeyicons/react";

import type { DockTab } from "./dock-toggle";

export const DOCK_TAB_META: Record<
  DockTab,
  { readonly icon: HoneyIcon; readonly label: string; readonly command: string }
> = {
  changes: { icon: GitDiff, label: "Changes", command: "dock.changes" },
  browser: { icon: Globe, label: "Browser", command: "browserPane.toggle" },
  files: { icon: Folder, label: "Files", command: "dock.files" },
};
