/**
 * The Browser settings page's words for the server's browser tool
 * (`browser.status`): agent-browser's install state and the mode it runs in.
 */
import type { BrowserToolStatus } from "@poseidon/contracts/rpc";

import { browserModeLabel } from "@/components/panes/browser/status";

/** The badge: the version agent-browser printed, or that it is missing. */
export const statusLabel = (status: BrowserToolStatus): string =>
  status.installed ? (status.version ?? "Installed") : "Not installed";

/** Beside the badge: which browser the agent drives on this run. */
export const modeLabel = (status: BrowserToolStatus): string | null =>
  status.mode === "in-app" ? "Drives the in-app browser" : browserModeLabel(status.mode);
