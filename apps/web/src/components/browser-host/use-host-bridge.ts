/**
 * The browser host's conversations with the desktop shell and the server:
 *
 * - **Tab requests.** The host is the window's tab host: it answers the
 *   shell's `create` / `close` / `select` (the agent's `Target.createTarget`,
 *   `closeTarget` and `bringToFront`, and a page's popups) through
 *   `window.openade.browserPane.serveTabs`, and resolves `create` with the new
 *   guest's `webContents` id once its webview can tell it.
 * - **Human input.** Every gesture the shell relays from a pane webview goes
 *   to the server as `browser.humanInput` — here rather than in the pane, so
 *   it is forwarded whether or not the pane is on screen.
 * - **Location.** Each thread's selected tab is reported as a passive
 *   `location` input, which mirrors the url without claiming control.
 * - **Teardown.** A thread the list shows archived loses its tabs; one the
 *   list stops holding was deleted, and also loses its browsing data.
 */
import * as React from "react";

import { useAtomSet } from "@effect/atom-react";
import type { BrowserPaneTabRequest } from "@OpenAde/client-runtime/resolver";
import { decodeThreadId, type ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";
import {
  BrowserHumanInput as BrowserHumanInputSchema,
  type BrowserHumanInput,
} from "@OpenAde/contracts/rpc";
import * as Schema from "effect/Schema";

import { getAppAtoms } from "@/state/app-runtime";
import {
  closedThreads,
  closeTab,
  dropThread,
  findByWcId,
  nextTabIdentity,
  openTab,
  selectedTab,
  selectTab,
  tabRefusal,
  type BrowserTabsState,
} from "@/state/browser-tabs";

import { whenTabReady } from "./tab-views";

type PaneBridge = NonNullable<NonNullable<Window["openade"]>["browserPane"]>;
type SetTabs = (update: (state: BrowserTabsState) => BrowserTabsState) => void;

/** What a pane tab may be opened on. */
const TAB_URL = /^(https?:\/\/|about:blank$)/i;

const asThreadId = (raw: string): ThreadId | null => {
  try {
    return decodeThreadId(raw);
  } catch {
    return null;
  }
};

/** Sends a gesture for a thread named by its raw id; a malformed id is dropped. */
export const useSendInput = () => {
  const send = useAtomSet(getAppAtoms().sendBrowserInput, { mode: "promiseExit" });
  return React.useCallback(
    (raw: string, input: BrowserHumanInput) => {
      const threadId = asThreadId(raw);
      if (threadId !== null) void send({ threadId, input });
    },
    [send],
  );
};

/** Serves the shell's tab requests for as long as the host is mounted. */
export const useTabRequests = (
  bridge: PaneBridge,
  state: BrowserTabsState,
  threads: ReadonlyArray<ThreadSummary> | null,
  setTabs: SetTabs,
) => {
  // The handler outlives renders; it reads the latest of both through refs.
  const stateRef = React.useRef(state);
  const threadsRef = React.useRef(threads);
  stateRef.current = state;
  threadsRef.current = threads;

  React.useEffect(() => {
    if (bridge.serveTabs === undefined) return;
    const tabOf = (wcId: number) => {
      const found = findByWcId(stateRef.current, wcId);
      if (found === null) throw new Error("the tab is not open in the browser pane");
      return found;
    };
    const handle = async (request: BrowserPaneTabRequest): Promise<{ wcId?: number }> => {
      switch (request.op) {
        case "create": {
          const refusal = tabRefusal(threadsRef.current, request.threadId);
          if (refusal !== null) throw new Error(refusal);
          if (!TAB_URL.test(request.url)) {
            throw new Error("a pane tab opens only http(s) pages and about:blank");
          }
          const identity = nextTabIdentity();
          setTabs((current) =>
            openTab(current, request.threadId, {
              ...identity,
              url: request.url,
              openedBy: request.opener === undefined ? "agent" : "popup",
              background: request.background,
              ...(request.opener !== undefined && { openerWcId: request.opener }),
            }),
          );
          return { wcId: await whenTabReady(identity.tabId) };
        }
        case "close": {
          const { threadId, tab } = tabOf(request.wcId);
          setTabs((current) => closeTab(current, threadId, tab.tabId));
          return {};
        }
        case "select": {
          const { threadId, tab } = tabOf(request.wcId);
          setTabs((current) => selectTab(current, threadId, tab.tabId));
          return {};
        }
      }
    };
    return bridge.serveTabs(handle);
  }, [bridge, setTabs]);
};

/**
 * Guest gestures (the shell's `before-input-event` relay) → `browser.humanInput`.
 * The contract schema is the boundary check: what does not parse is dropped.
 */
export const useGuestInput = (bridge: PaneBridge) => {
  const send = useSendInput();
  React.useEffect(
    () =>
      bridge.onInput(({ threadId, input }) => {
        const parsed = Schema.decodeUnknownExit(BrowserHumanInputSchema)(input);
        if (parsed._tag === "Success") send(threadId, parsed.value);
      }),
    [bridge, send],
  );
};

/** Reports each thread's selected tab as a passive `location` when it changes. */
export const useLocationSync = (state: BrowserTabsState) => {
  const send = useSendInput();
  const reported = React.useRef(new Map<string, string>());
  React.useEffect(() => {
    for (const [threadId, thread] of Object.entries(state)) {
      const tab = selectedTab(thread);
      if (tab === null || !/^https?:\/\//i.test(tab.url)) continue;
      const key = `${tab.url}\n${tab.title}`;
      if (reported.current.get(threadId) === key) continue;
      reported.current.set(threadId, key);
      send(threadId, {
        kind: "location",
        url: tab.url,
        ...(tab.title !== "" && { title: tab.title }),
      });
    }
  }, [state, send]);
};

/** How long a thread may be missing from the list before it counts as deleted. */
const DELETED_AFTER_MS = 2_000;
/**
 * An empty list is also what a resnapshot looks like before its snapshot
 * lands, so a thread missing from one gets longer.
 */
const DELETED_FROM_EMPTY_AFTER_MS = 10_000;

/**
 * Drops the tabs of archived threads at once, and of deleted ones — gone from
 * the list for a grace period while connected — along with their browsing
 * data (`clearThread`, which the shell validates).
 */
export const useThreadTeardown = (
  bridge: PaneBridge,
  state: BrowserTabsState,
  threads: ReadonlyArray<ThreadSummary> | null,
  connected: boolean,
  setTabs: SetTabs,
) => {
  const known = React.useRef(new Set<string>());
  const missingSince = React.useRef(new Map<string, number>());
  // Bumped after a drop, so threads that were not due yet get their own timer.
  const [pass, setPass] = React.useState(0);
  const tabThreads = Object.keys(state).join("\n");

  React.useEffect(() => {
    if (threads === null || !connected) return;
    for (const thread of threads) known.current.add(thread.threadId);
    const withTabs = tabThreads === "" ? [] : tabThreads.split("\n");
    const { archived, missing } = closedThreads(threads, [...known.current, ...withTabs]);
    if (archived.length > 0) {
      setTabs((current) => archived.reduce(dropThread, current));
    }
    const now = Date.now();
    const since = missingSince.current;
    for (const threadId of since.keys()) {
      if (!missing.includes(threadId)) since.delete(threadId);
    }
    for (const threadId of missing) if (!since.has(threadId)) since.set(threadId, now);
    if (missing.length === 0) return;

    const grace = threads.length === 0 ? DELETED_FROM_EMPTY_AFTER_MS : DELETED_AFTER_MS;
    const due = Math.min(...missing.map((threadId) => since.get(threadId) ?? now)) + grace;
    const timer = window.setTimeout(
      () => {
        const deleted = missing.filter(
          (threadId) => (since.get(threadId) ?? Date.now()) + grace <= Date.now(),
        );
        setTabs((current) => deleted.reduce(dropThread, current));
        for (const threadId of deleted) {
          since.delete(threadId);
          known.current.delete(threadId);
          void bridge.clearThread?.(threadId).catch((error: unknown) => {
            console.warn(`[browser] could not clear thread ${threadId}: ${String(error)}`);
          });
        }
        setPass((count) => count + 1);
      },
      Math.max(0, due - now),
    );
    return () => window.clearTimeout(timer);
  }, [bridge, threads, connected, tabThreads, setTabs, pass]);
};
