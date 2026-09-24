/**
 * Where the dock keys and buttons take the right dock. `null` closes it.
 *
 * - `dock.toggle` (and the header's dock button) closes an open dock, and
 *   opens a closed one on the tab it was last closed on, else `changes`.
 * - `dock.changes`, `dock.files` and `browserPane.toggle` open their tab, or
 *   close the dock when it is already showing that tab.
 */

import type { DockTab } from "@/components/dock/right-dock";

export const dockToggleTarget = (
  open: DockTab | undefined,
  last: DockTab | undefined,
): DockTab | null => (open !== undefined ? null : (last ?? "changes"));

export const dockTabTarget = (open: DockTab | undefined, tab: DockTab): DockTab | null =>
  open === tab ? null : tab;
