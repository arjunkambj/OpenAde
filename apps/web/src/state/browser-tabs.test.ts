import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import { describe, expect, it } from "vitest";

import {
  closedThreads,
  closeTab,
  dropThread,
  findByWcId,
  openTab,
  patchTab,
  selectedTab,
  selectTab,
  tabRefusal,
  tabsInCreationOrder,
  type BrowserTabsState,
  type OpenTab,
} from "./browser-tabs";

const A = "thread-a";
const B = "thread-b";

let seq = 0;
const open = (url: string, extra: Partial<OpenTab> = {}): OpenTab => {
  seq += 1;
  return {
    tabId: `t${seq}`,
    seq,
    url,
    openedBy: "agent",
    background: false,
    ...extra,
  };
};

const ids = (state: BrowserTabsState, threadId: string) =>
  (state[threadId]?.tabs ?? []).map((tab) => tab.tabId);

/** A thread with three attached tabs, t-1 · t-2 · t-3, wcIds 101…103. */
const threeTabs = (): BrowserTabsState => {
  let state: BrowserTabsState = {};
  for (const [index, tabId] of ["t-1", "t-2", "t-3"].entries()) {
    state = openTab(state, A, { ...open("https://a.test/"), tabId });
    state = patchTab(state, A, tabId, { wcId: 101 + index });
  }
  return state;
};

const summary = (threadId: string, status: ThreadSummary["status"]): ThreadSummary =>
  ({ threadId, status }) as unknown as ThreadSummary;

describe("browser tabs", () => {
  it("creates a tab selected, on the url it was asked for, not yet attached", () => {
    const state = openTab({}, A, { ...open("https://a.test/"), tabId: "x" });
    expect(state[A]?.selected).toBe("x");
    expect(state[A]?.tabs[0]).toMatchObject({
      tabId: "x",
      initialUrl: "https://a.test/",
      url: "https://a.test/",
      wcId: null,
      loading: true,
      openedBy: "agent",
    });
  });

  it("opens a background tab last without taking the selection, unless nothing is selected", () => {
    let state = openTab({}, A, { ...open("about:blank", { background: true }), tabId: "first" });
    expect(state[A]?.selected).toBe("first");
    state = openTab(state, A, { ...open("about:blank", { background: true }), tabId: "second" });
    expect(ids(state, A)).toEqual(["first", "second"]);
    expect(state[A]?.selected).toBe("first");
  });

  it("selects a tab of its own thread only", () => {
    let state = threeTabs();
    state = selectTab(state, A, "t-1");
    expect(state[A]?.selected).toBe("t-1");
    expect(selectTab(state, A, "missing")).toBe(state);
    expect(selectTab(state, B, "t-2")).toBe(state);
  });

  it("closes a tab and drops the thread's entry with its last one", () => {
    let state = threeTabs();
    state = closeTab(state, A, "t-1");
    expect(ids(state, A)).toEqual(["t-2", "t-3"]);
    state = closeTab(closeTab(state, A, "t-2"), A, "t-3");
    expect(state).toEqual({});
    expect(closeTab(state, A, "t-3")).toBe(state);
  });

  it("closing the selected tab selects its right neighbour, else its left", () => {
    let state = selectTab(threeTabs(), A, "t-2");
    state = closeTab(state, A, "t-2");
    expect(state[A]?.selected).toBe("t-3");
    state = closeTab(state, A, "t-3");
    expect(state[A]?.selected).toBe("t-1");
  });

  it("closing a tab that is not selected keeps the selection", () => {
    const state = closeTab(selectTab(threeTabs(), A, "t-3"), A, "t-1");
    expect(state[A]?.selected).toBe("t-3");
  });

  it("inserts a popup right after the tab that opened it", () => {
    const state = openTab(selectTab(threeTabs(), A, "t-3"), A, {
      ...open("https://popup.test/", { openedBy: "popup", openerWcId: 101 }),
      tabId: "popup",
    });
    expect(ids(state, A)).toEqual(["t-1", "popup", "t-2", "t-3"]);
    expect(state[A]?.selected).toBe("popup");
    expect(selectedTab(state[A])?.openedBy).toBe("popup");
  });

  it("puts a popup whose opener is gone last", () => {
    const state = openTab(threeTabs(), A, {
      ...open("https://popup.test/", { openedBy: "popup", openerWcId: 999 }),
      tabId: "popup",
    });
    expect(ids(state, A)).toEqual(["t-1", "t-2", "t-3", "popup"]);
  });

  it("finds a tab by its guest id across threads", () => {
    let state = threeTabs();
    state = openTab(state, B, { ...open("https://b.test/"), tabId: "b-1" });
    state = patchTab(state, B, "b-1", { wcId: 201 });
    expect(findByWcId(state, 201)).toMatchObject({ threadId: B, tab: { tabId: "b-1" } });
    expect(findByWcId(state, 102)).toMatchObject({ threadId: A, tab: { tabId: "t-2" } });
    expect(findByWcId(state, 7)).toBeNull();
  });

  it("renders tabs in creation order whatever the strip order, so none ever moves", () => {
    let state = threeTabs();
    state = openTab(state, B, { ...open("https://b.test/"), tabId: "b-1" });
    state = openTab(state, A, {
      ...open("https://popup.test/", { openedBy: "popup", openerWcId: 101 }),
      tabId: "popup",
    });
    expect(ids(state, A)).toEqual(["t-1", "popup", "t-2", "t-3"]);
    expect(tabsInCreationOrder(state).map(({ tab }) => tab.tabId)).toEqual([
      "t-1",
      "t-2",
      "t-3",
      "b-1",
      "popup",
    ]);
  });

  it("drops every tab of one thread and leaves the others", () => {
    let state = openTab(threeTabs(), B, { ...open("https://b.test/"), tabId: "b-1" });
    state = dropThread(state, A);
    expect(Object.keys(state)).toEqual([B]);
  });
});

describe("tabRefusal", () => {
  const threads = [summary(A, "idle"), summary(B, "archived")];

  it("lets an open thread open a tab", () => {
    expect(tabRefusal(threads, A)).toBeNull();
  });

  it("refuses an archived thread, a thread the list does not hold, and an unloaded list", () => {
    expect(tabRefusal(threads, B)).toBe("the thread is archived");
    expect(tabRefusal(threads, "gone")).toBe("the thread is not open in the Poseidon window");
    expect(tabRefusal(null, A)).toMatch(/not loaded/);
  });
});

describe("closedThreads", () => {
  it("splits what the host knows into archived and missing", () => {
    const threads = [summary(A, "running"), summary(B, "archived")];
    expect(closedThreads(threads, [A, B, "deleted", "deleted"])).toEqual({
      archived: [B],
      missing: ["deleted"],
    });
  });
});
