/**
 * What the pane's status chip says, as a pure function of `BrowserState`.
 *
 * It lives apart from the toolbar component because the one rule that is easy
 * to get wrong — "who is driving" — deserves a test: `activeTool` is *absent*
 * before the first `browser_*` call and explicitly `null` after one settles
 * (the service writes the null), so the chip must test for a tool name, not
 * for `!== undefined`.
 */

import type { BrowserState } from "@OpenAde/contracts/rpc";

export interface BrowserStatusChip {
  /** Tailwind classes for the leading dot. */
  readonly dot: string;
  readonly label: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The kill switch, as the pane words it. */
export const BROWSER_DISABLED_LABEL = "In-app browser is disabled (OPENADE_REMOTE_DEBUG=0)";

/**
 * Which browser the pane is showing, when it is not the ordinary in-app one:
 * the web renderer's headless Chromium, or no browser at all.
 */
export const browserModeLabel = (mode: BrowserState["mode"]): string | null => {
  switch (mode) {
    case "in-app":
      return null;
    case "owned-chromium":
      return "Headless browser (web mode)";
    case "disabled":
      return BROWSER_DISABLED_LABEL;
  }
};

export const browserStatus = (state: BrowserState | null): BrowserStatusChip => {
  if (state === null) return { dot: "bg-muted-foreground", label: "connecting" };
  if (state.mode === "disabled") return { dot: "bg-muted-foreground", label: "disabled" };
  if (typeof state.activeTool === "string" && state.activeTool !== "") {
    return { dot: "bg-permission animate-pulse", label: `agent: ${state.activeTool}` };
  }
  switch (state.status) {
    case "ready":
      return { dot: "bg-added", label: state.url === null ? "ready" : hostOf(state.url) };
    case "starting":
      return { dot: "bg-permission animate-pulse", label: "starting" };
    case "error":
      return { dot: "bg-destructive", label: state.message ?? "error" };
    case "stopped":
      return { dot: "bg-muted-foreground", label: "stopped" };
  }
};

/**
 * Whether the chip has anything to say. In the in-app browser an idle agent
 * session — never started, or parked on a page — reads as "stopped" or the
 * page's host, which the address bar and the tab already show; the chip only
 * speaks up while the agent drives, the session starts, or something fails.
 */
export const browserStatusVisible = (state: BrowserState | null): boolean => {
  if (state === null || state.mode !== "in-app") return true;
  if (typeof state.activeTool === "string" && state.activeTool !== "") return true;
  return state.status === "starting" || state.status === "error";
};

/**
 * What the frame surface says when there is no frame yet.
 *
 * It used to be `state.message ?? "starting…"`, which told a *stopped* browser
 * it was starting — the status chip beside it said "stopped" at the same time.
 * Nothing is starting until an agent call (or the address bar) asks for it.
 */
export const frameFallback = (state: BrowserState): string => {
  switch (state.status) {
    case "ready":
      return "waiting for first frame…";
    case "starting":
      return state.message ?? "starting…";
    case "error":
      return state.message ?? "the browser could not start";
    case "stopped":
      return state.message ?? "not running — it starts on the first agent call";
  }
};
