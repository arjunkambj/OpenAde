/**
 * What a person's toolbar button or pane key does to an in-app tab.
 *
 * In-app, the webview is the page: back, forward, reload, stop and a typed
 * address move it directly, and the server only hears about it — as the
 * matching `browser.humanInput` gesture, which bumps the human-control epoch
 * so an agent call in flight settles as `interrupted_by_human`, and never
 * makes the server run agent-browser for the person. Both the pane's toolbar
 * and the keys the shell relays from inside a page (`../browser-host`) come
 * through here.
 */
import type { BrowserHumanInput } from "@poseidon/contracts/rpc";

import type { WebviewElement } from "@/components/browser-host/tab-views";

import { isPaneUrl } from "./address";

export type HistoryDirection = "back" | "forward" | "reload" | "stop";

/**
 * Moves the webview. Every webview method throws until the guest's first
 * `dom-ready`; before that there is no page to move, so nothing happens.
 */
export const moveTab = (view: WebviewElement, direction: HistoryDirection): void => {
  try {
    if (direction === "back") view.goBack();
    else if (direction === "forward") view.goForward();
    else if (direction === "reload") view.reload();
    else view.stop();
  } catch {
    // Not ready yet.
  }
};

/** Loads `url` in the webview, http(s) and `about:blank` only. */
export const loadInTab = (view: WebviewElement, url: string): void => {
  if (!isPaneUrl(url)) return;
  void Promise.resolve()
    .then(() => view.loadURL(url))
    .catch(() => undefined);
};

/** The gesture the server hears for a history move. */
export const historyInput = (direction: HistoryDirection): BrowserHumanInput => ({
  kind: "history",
  direction,
});

/** The pane commands that move a tab, by command id. */
export const COMMAND_DIRECTIONS: Readonly<Record<string, HistoryDirection>> = {
  "browser.reload": "reload",
  "browser.back": "back",
  "browser.forward": "forward",
};

/** The pane's keybinding commands. */
export const BROWSER_COMMANDS = {
  focusUrl: "browser.focusUrl",
  reload: "browser.reload",
  back: "browser.back",
  forward: "browser.forward",
} as const;
