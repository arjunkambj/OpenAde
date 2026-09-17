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

export const browserStatus = (state: BrowserState | null): BrowserStatusChip => {
  if (state === null) return { dot: "bg-muted-foreground/40", label: "connecting" };
  if (typeof state.activeTool === "string" && state.activeTool !== "") {
    return { dot: "bg-amber-500 animate-pulse", label: `agent: ${state.activeTool}` };
  }
  switch (state.status) {
    case "ready":
      return { dot: "bg-emerald-500", label: state.url === null ? "ready" : hostOf(state.url) };
    case "starting":
      return { dot: "bg-amber-500 animate-pulse", label: "starting" };
    case "error":
      return { dot: "bg-red-500", label: state.message ?? "error" };
    case "stopped":
      return { dot: "bg-muted-foreground/40", label: "stopped" };
  }
};
