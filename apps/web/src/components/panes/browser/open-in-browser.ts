/**
 * "Open this URL in the thread's browser pane" — the one entry point other
 * surfaces call (a terminal link, a link in a tool row), so they never reach
 * into the pane's tabs or the dock's route themselves.
 *
 * - On the desktop it opens a pane tab on the url — or selects the thread's
 *   tab already showing it — and the browser host creates its webview.
 * - Then it reveals the pane: the thread view opens its dock on Browser, now
 *   or when the thread is next on screen. `reveal: false` leaves the dock
 *   alone.
 * - In the web renderer (no desktop, so no pane tabs) it navigates the
 *   thread's headless browser through the server, as the address bar does.
 *
 * Only http(s) pages open: the pane is a web browser, and a `file:` or
 * `javascript:` url from a terminal is exactly what must not reach it.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { getAppAtomRegistry, getAppAtoms } from "@/state/app-runtime";
import { requestBrowserReveal } from "@/state/browser-activity";
import {
  nextTabIdentity,
  openTab,
  selectTab,
  updateBrowserTabs,
  type BrowserTabsState,
} from "@/state/browser-tabs";

export type OpenInBrowserResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/** The url, normalised, when it is an http(s) page; `null` for anything else. */
export const webUrlOf = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/** Selects the thread's tab already on `url`, or opens a new selected one on it. */
export const openOrSelect = (
  state: BrowserTabsState,
  threadId: string,
  url: string,
): BrowserTabsState => {
  const existing = state[threadId]?.tabs.find((tab) => tab.url === url);
  if (existing !== undefined) return selectTab(state, threadId, existing.tabId);
  return openTab(state, threadId, {
    ...nextTabIdentity(),
    url,
    openedBy: "human",
    background: false,
  });
};

/**
 * Runs a function atom once from outside React. The registry drops an atom
 * nothing subscribes to on its next tick — interrupting the call — so this
 * keeps it mounted until the call settles.
 */
const runOnce = <Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): void => {
  const unmount = registry.mount(atom);
  registry.set(atom, arg);
  const stop = registry.subscribe(atom, (result) => {
    if (!result.waiting) {
      stop();
      unmount();
    }
  });
};

export interface OpenInThreadBrowserOptions {
  /** Show the thread's browser pane as well; on unless set to `false`. */
  readonly reveal?: boolean;
}

/**
 * The pane's entry point with its registry and environment passed in: the
 * app calls `openInThreadBrowser`, tests call this.
 */
export const openInThreadBrowserWith = (
  env: {
    readonly registry: AtomRegistry.AtomRegistry;
    /** The desktop hosts pane tabs; the web renderer does not. */
    readonly hostsTabs: boolean;
    readonly navigateHeadless: (threadId: ThreadId, url: string) => void;
  },
  threadId: ThreadId,
  raw: string,
  options: OpenInThreadBrowserOptions = {},
): OpenInBrowserResult => {
  const url = webUrlOf(raw);
  if (url === null) {
    return { ok: false, reason: "the browser pane opens only http and https pages" };
  }
  if (env.hostsTabs) {
    updateBrowserTabs(env.registry, (state) => openOrSelect(state, threadId, url));
  } else {
    env.navigateHeadless(threadId, url);
  }
  if (options.reveal !== false) requestBrowserReveal(env.registry, threadId);
  return { ok: true, url };
};

/**
 * Opens `url` in the thread's browser pane and shows the pane (unless
 * `reveal: false`). Safe to call from any click handler.
 *
 * @public — the terminal's links call it.
 */
export const openInThreadBrowser = (
  threadId: ThreadId,
  url: string,
  options: OpenInThreadBrowserOptions = {},
): OpenInBrowserResult => {
  const registry = getAppAtomRegistry();
  return openInThreadBrowserWith(
    {
      registry,
      hostsTabs: window.openade?.browserPane?.serveTabs !== undefined,
      navigateHeadless: (id, target) =>
        runOnce(registry, getAppAtoms().sendBrowserInput, {
          threadId: id,
          input: { kind: "navigate", url: target },
        }),
    },
    threadId,
    url,
    options,
  );
};
