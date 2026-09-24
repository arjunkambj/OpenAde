/**
 * Each project's browser history (`@/components/panes/browser/history`),
 * kept in this window's localStorage the way `./ui` keeps layout: read once
 * at start, written through on every change, and an atom either way when
 * storage is blocked or full.
 *
 * `keepAlive`: the recorder is the browser host, which is always mounted on
 * the desktop, but the web renderer's pane records while it is open only,
 * and closing it must not drop the history it just wrote.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import {
  parseHistory,
  withVisit,
  type BrowserHistory,
  type HistoryEntry,
} from "@/components/panes/browser/history";

const HISTORY_KEY = "openade:browser-history";

const NONE: ReadonlyArray<HistoryEntry> = [];

const readHistory = (): BrowserHistory => {
  try {
    return parseHistory(globalThis.localStorage?.getItem(HISTORY_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return {};
  }
};

const historyAtom = Atom.keepAlive(Atom.make<BrowserHistory>(readHistory()));

/** One project's pages, newest first. */
export const useBrowserHistory = (projectId: string | null): ReadonlyArray<HistoryEntry> =>
  useAtomValue(
    historyAtom,
    React.useCallback(
      (history: BrowserHistory) => (projectId === null ? NONE : (history[projectId] ?? NONE)),
      [projectId],
    ),
  );

/** Records a visit in a project's history; anything but an http(s) page is ignored. */
export const useRecordVisit = () => {
  const setHistory = useAtomSet(historyAtom);
  return React.useCallback(
    (projectId: string, url: string, title: string) =>
      setHistory((current) => {
        const next = withVisit(current, projectId, url, title);
        if (next === current) return current;
        try {
          globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return next;
      }),
    [setHistory],
  );
};

/** Forgets every project's history — the Browser settings page's "Clear browsing data". */
export const useClearBrowserHistory = () => {
  const setHistory = useAtomSet(historyAtom);
  return React.useCallback(() => {
    try {
      globalThis.localStorage?.removeItem(HISTORY_KEY);
    } catch {
      // Blocked storage; the atom still empties.
    }
    setHistory({});
  }, [setHistory]);
};
