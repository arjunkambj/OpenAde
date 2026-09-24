/**
 * Records every pane tab's pages in its project's browser history — the
 * agent's as well as a person's, shown or hidden — so the address bar can
 * suggest them later. A tab is recorded when its url or title changes; the
 * history itself keeps only http(s) pages (`@/components/panes/browser/history`).
 */
import * as React from "react";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { useRecordVisit } from "@/state/browser-history";
import type { BrowserTabsState } from "@/state/browser-tabs";

export const useHistoryRecorder = (
  state: BrowserTabsState,
  threads: ReadonlyArray<ThreadSummary> | null,
) => {
  const recordVisit = useRecordVisit();
  const recorded = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    if (threads === null) return;
    const projectOf = new Map(threads.map((thread) => [thread.threadId, thread.projectId]));
    const live = new Set<string>();
    for (const [threadId, thread] of Object.entries(state)) {
      const projectId = projectOf.get(threadId as ThreadSummary["threadId"]);
      for (const tab of thread.tabs) {
        live.add(tab.tabId);
        if (projectId === undefined || tab.loading) continue;
        const key = `${tab.url}\n${tab.title}`;
        if (recorded.current.get(tab.tabId) === key) continue;
        recorded.current.set(tab.tabId, key);
        recordVisit(projectId, tab.url, tab.title);
      }
    }
    for (const tabId of recorded.current.keys()) {
      if (!live.has(tabId)) recorded.current.delete(tabId);
    }
  }, [state, threads, recordVisit]);
};
