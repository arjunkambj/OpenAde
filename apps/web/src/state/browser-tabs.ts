/**
 * The in-app browser's tabs, per thread — presentation state the window owns.
 *
 * A pane tab is a `<webview>` the browser host (`@/components/browser-host`)
 * renders above the routes, so it lives as long as the window and not as long
 * as the dock. What each thread has open, which tab is showing, and what each
 * tab's page is doing (url, title, loading, history) is kept here, keyed by
 * thread; the reducers are pure so the rules — where a popup goes, which tab
 * a close selects, which thread may open one — are tested without a DOM.
 *
 * Nothing here reaches the server. The agent's view of the same tabs comes
 * from the shell's browser bridge, which asks the host for tabs through the
 * preload (`window.openade.browserPane.serveTabs`).
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";
import type { AtomRegistry } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** Who asked for the tab: the agent (`Target.createTarget`), a page's popup, or a person. */
export type TabOpener = "agent" | "human" | "popup";

export interface BrowserTab {
  readonly tabId: string;
  /** Creation order, across every thread: the host renders tabs in this order. */
  readonly seq: number;
  /** What the webview's `src` starts as; never changes, so React never re-navigates it. */
  readonly initialUrl: string;
  /** The guest's `webContents` id, once the webview can tell it (its first `dom-ready`). */
  readonly wcId: number | null;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** The page's icon, http(s) only; null until the page names one. */
  readonly favicon: string | null;
  /** The webview's zoom level (factor 1.2^level); 0 is 100%. */
  readonly zoomLevel: number;
  readonly openedBy: TabOpener;
}

export interface ThreadTabs {
  /** In tab-strip order. */
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly selected: string | null;
}

export type BrowserTabsState = Readonly<Record<string, ThreadTabs>>;

const emptyThreadTabs: ThreadTabs = { tabs: [], selected: null };

export interface OpenTab {
  readonly tabId: string;
  readonly seq: number;
  readonly url: string;
  readonly openedBy: TabOpener;
  /** Open behind the current tab rather than selecting it. */
  readonly background: boolean;
  /** For a popup: the `webContents` id of the tab that opened it. */
  readonly openerWcId?: number;
}

let lastSeq = 0;

/** A fresh tab id and creation stamp. */
export const nextTabIdentity = (): { readonly tabId: string; readonly seq: number } => {
  lastSeq += 1;
  return { tabId: `tab-${lastSeq}`, seq: lastSeq };
};

const withThread = (
  state: BrowserTabsState,
  threadId: string,
  next: ThreadTabs,
): BrowserTabsState => {
  if (next.tabs.length === 0) {
    if (!(threadId in state)) return state;
    const rest = { ...state };
    delete rest[threadId];
    return rest;
  }
  return { ...state, [threadId]: next };
};

/**
 * Adds a tab. A popup goes right after the tab that opened it, as in a
 * browser; everything else goes last. A background tab is selected only when
 * nothing else is.
 */
export const openTab = (
  state: BrowserTabsState,
  threadId: string,
  open: OpenTab,
): BrowserTabsState => {
  const current = state[threadId] ?? emptyThreadTabs;
  const tab: BrowserTab = {
    tabId: open.tabId,
    seq: open.seq,
    initialUrl: open.url,
    wcId: null,
    url: open.url,
    title: "",
    loading: true,
    canGoBack: false,
    canGoForward: false,
    favicon: null,
    zoomLevel: 0,
    openedBy: open.openedBy,
  };
  const openerIndex =
    open.openerWcId === undefined
      ? -1
      : current.tabs.findIndex((entry) => entry.wcId === open.openerWcId);
  const at = openerIndex === -1 ? current.tabs.length : openerIndex + 1;
  const tabs = [...current.tabs.slice(0, at), tab, ...current.tabs.slice(at)];
  const selected = open.background ? (current.selected ?? tab.tabId) : tab.tabId;
  return withThread(state, threadId, { tabs, selected });
};

/** Removes a tab; closing the selected one selects its right neighbour, else its left. */
export const closeTab = (
  state: BrowserTabsState,
  threadId: string,
  tabId: string,
): BrowserTabsState => {
  const current = state[threadId];
  const index = current?.tabs.findIndex((tab) => tab.tabId === tabId) ?? -1;
  if (current === undefined || index === -1) return state;
  const tabs = current.tabs.filter((tab) => tab.tabId !== tabId);
  const selected =
    current.selected !== tabId
      ? current.selected
      : (tabs[index]?.tabId ?? tabs[index - 1]?.tabId ?? null);
  return withThread(state, threadId, { tabs, selected });
};

export const selectTab = (
  state: BrowserTabsState,
  threadId: string,
  tabId: string,
): BrowserTabsState => {
  const current = state[threadId];
  if (current === undefined || current.selected === tabId) return state;
  if (!current.tabs.some((tab) => tab.tabId === tabId)) return state;
  return { ...state, [threadId]: { ...current, selected: tabId } };
};

export type TabPatch = Partial<
  Pick<
    BrowserTab,
    "wcId" | "url" | "title" | "loading" | "canGoBack" | "canGoForward" | "favicon" | "zoomLevel"
  >
>;

/** What the tab's webview reported: its guest id, its page, its history. */
export const patchTab = (
  state: BrowserTabsState,
  threadId: string,
  tabId: string,
  patch: TabPatch,
): BrowserTabsState => {
  const current = state[threadId];
  if (current === undefined || !current.tabs.some((tab) => tab.tabId === tabId)) return state;
  return {
    ...state,
    [threadId]: {
      ...current,
      tabs: current.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, ...patch } : tab)),
    },
  };
};

/** Every tab of a thread goes: the thread was archived or deleted. */
export const dropThread = (state: BrowserTabsState, threadId: string): BrowserTabsState =>
  withThread(state, threadId, emptyThreadTabs);

/** The tab whose guest is `wcId`, and its thread. */
export const findByWcId = (
  state: BrowserTabsState,
  wcId: number,
): { readonly threadId: string; readonly tab: BrowserTab } | null => {
  for (const [threadId, thread] of Object.entries(state)) {
    const tab = thread.tabs.find((entry) => entry.wcId === wcId);
    if (tab !== undefined) return { threadId, tab };
  }
  return null;
};

export const selectedTab = (thread: ThreadTabs | undefined): BrowserTab | null =>
  thread?.tabs.find((tab) => tab.tabId === thread.selected) ?? null;

/**
 * What the tab strip calls a tab: "New tab" for a blank one, else its
 * title, else its url without the scheme.
 */
export const tabLabel = (tab: Pick<BrowserTab, "title" | "url">): string => {
  // A blank page reports its url as its title.
  if (tab.url === "" || tab.url === "about:blank") return "New tab";
  const title = tab.title.trim();
  if (title !== "") return title;
  return tab.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
};

/**
 * The icon a page's `page-favicon-updated` names: the first http(s) one. The
 * window loads it as an image, so nothing but a web url gets through.
 */
export const faviconOf = (favicons: unknown): string | null => {
  if (!Array.isArray(favicons)) return null;
  const first = favicons.find(
    (entry): entry is string => typeof entry === "string" && /^https?:\/\//i.test(entry),
  );
  return first === undefined || first.length > 2048 ? null : first;
};

/**
 * Every tab of every thread, oldest first. The host renders them in this
 * order, which only ever appends or removes: React never has to move a
 * webview, and moving one in the DOM re-creates its guest.
 */
export const tabsInCreationOrder = (
  state: BrowserTabsState,
): ReadonlyArray<{ readonly threadId: string; readonly tab: BrowserTab }> =>
  Object.entries(state)
    .flatMap(([threadId, thread]) => thread.tabs.map((tab) => ({ threadId, tab })))
    .sort((a, b) => a.tab.seq - b.tab.seq);

/**
 * Why a thread may not open a tab, or `null` when it may. Only a thread the
 * client fold holds and has not archived may: the shell asks on the agent's
 * behalf, and a thread that is gone must not grow a browser in the background.
 */
export const tabRefusal = (
  threads: ReadonlyArray<ThreadSummary> | null,
  threadId: string,
): string | null => {
  if (threads === null) return "the OpenAde window has not loaded its threads yet";
  const thread = threads.find((entry) => entry.threadId === threadId);
  if (thread === undefined) return "the thread is not open in the OpenAde window";
  if (thread.status === "archived") return "the thread is archived";
  return null;
};

/**
 * Of the threads the host knows about, which the list now shows archived and
 * which it no longer holds at all. A missing thread was deleted — or the list
 * is between a resnapshot and its snapshot, which the caller waits out.
 */
export const closedThreads = (
  threads: ReadonlyArray<ThreadSummary>,
  known: Iterable<string>,
): { readonly archived: ReadonlyArray<string>; readonly missing: ReadonlyArray<string> } => {
  const status = new Map(threads.map((thread) => [thread.threadId as string, thread.status]));
  const archived: Array<string> = [];
  const missing: Array<string> = [];
  for (const threadId of new Set(known)) {
    const now = status.get(threadId);
    if (now === undefined) missing.push(threadId);
    else if (now === "archived") archived.push(threadId);
  }
  return { archived, missing };
};

// `keepAlive`: the host is the one subscriber that always exists, but the
// pane reads a thread's slice on its own, and tabs must never be dropped
// because nothing happened to be reading them for a moment.
const browserTabsAtom = Atom.keepAlive(Atom.make<BrowserTabsState>({}));

export const useBrowserTabs = (): BrowserTabsState => useAtomValue(browserTabsAtom);

export const useSetBrowserTabs = () => useAtomSet(browserTabsAtom);

/** The tabs in `registry`, updated from outside React (`openInThreadBrowser`). */
export const updateBrowserTabs = (
  registry: AtomRegistry.AtomRegistry,
  update: (state: BrowserTabsState) => BrowserTabsState,
): void => registry.update(browserTabsAtom, update);

/** One thread's tabs. */
export const useThreadTabs = (threadId: string): ThreadTabs =>
  useAtomValue(
    browserTabsAtom,
    React.useCallback((state: BrowserTabsState) => state[threadId] ?? emptyThreadTabs, [threadId]),
  );

/**
 * Where the browser pane is on screen: the element the thread's selected tab
 * is laid over. At most one pane is mounted, so there is one slot or none.
 */
export interface BrowserSlot {
  readonly threadId: string;
  readonly element: HTMLElement;
}

const browserSlotAtom = Atom.keepAlive(Atom.make<BrowserSlot | null>(null));

export const useBrowserSlot = (): BrowserSlot | null => useAtomValue(browserSlotAtom);

export const useSetBrowserSlot = () => useAtomSet(browserSlotAtom);
