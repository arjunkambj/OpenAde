/**
 * The tab strip's rules, on the reducers it edits: where popups and the
 * agent's tabs land, what gets selected, and what an entry is called.
 */
import { describe, expect, it } from "vitest";

import {
  closeTab,
  faviconOf,
  openTab,
  patchTab,
  selectTab,
  tabLabel,
  type BrowserTabsState,
  type OpenTab,
  type TabOpener,
} from "@/state/browser-tabs";

const T = "thread-a";

let seq = 0;
const open = (openedBy: TabOpener, extra: Partial<OpenTab> = {}): OpenTab => {
  seq += 1;
  return {
    tabId: `t${seq}`,
    seq,
    url: "https://a.test/",
    openedBy,
    background: false,
    ...extra,
  };
};

const strip = (state: BrowserTabsState) => ({
  order: (state[T]?.tabs ?? []).map((tab) => `${tab.openedBy}:${tab.tabId}`),
  selected: state[T]?.selected ?? null,
});

/** A person's tab and an agent tab, both attached (wcIds 11, 12). */
const twoTabs = (): BrowserTabsState => {
  let state: BrowserTabsState = {};
  state = openTab(state, T, open("human", { tabId: "h" }));
  state = patchTab(state, T, "h", { wcId: 11 });
  state = openTab(state, T, open("agent", { tabId: "a" }));
  state = patchTab(state, T, "a", { wcId: 12 });
  return state;
};

describe("tab strip", () => {
  it("puts each popup right after its opener, in the order they were opened", () => {
    let state = twoTabs();
    state = selectTab(state, T, "h");
    state = openTab(state, T, open("popup", { tabId: "p1", openerWcId: 11 }));
    state = patchTab(state, T, "p1", { wcId: 13 });
    // A popup of the popup goes after it; a second popup of the first tab
    // goes straight after the first tab, ahead of its earlier popup.
    state = openTab(state, T, open("popup", { tabId: "p2", openerWcId: 13 }));
    state = openTab(state, T, open("popup", { tabId: "p3", openerWcId: 11 }));
    expect(strip(state)).toEqual({
      order: ["human:h", "popup:p3", "popup:p1", "popup:p2", "agent:a"],
      selected: "p3",
    });
  });

  it("selects the tab the agent opens, and one it brings to the front", () => {
    let state = twoTabs();
    expect(strip(state).selected).toBe("a");
    state = selectTab(state, T, "h");
    // `browser_tabs new` → `Target.createTarget`, not in the background.
    state = openTab(state, T, open("agent", { tabId: "a2" }));
    expect(strip(state)).toEqual({ order: ["human:h", "agent:a", "agent:a2"], selected: "a2" });
    // `Page.bringToFront` on the first agent tab.
    state = selectTab(state, T, "a");
    expect(strip(state).selected).toBe("a");
  });

  it("leaves the person's tab selected when the agent opens one in the background", () => {
    let state = twoTabs();
    state = selectTab(state, T, "h");
    state = openTab(state, T, open("agent", { tabId: "bg", background: true }));
    expect(strip(state)).toEqual({ order: ["human:h", "agent:a", "agent:bg"], selected: "h" });
  });

  it("new tab opens last and selected; closing it goes back to its left neighbour", () => {
    let state = twoTabs();
    state = selectTab(state, T, "h");
    state = openTab(state, T, open("human", { tabId: "n", url: "about:blank" }));
    expect(strip(state)).toEqual({ order: ["human:h", "agent:a", "human:n"], selected: "n" });
    state = closeTab(state, T, "n");
    expect(strip(state)).toEqual({ order: ["human:h", "agent:a"], selected: "a" });
  });
});

describe("tabLabel", () => {
  it("calls a blank tab New tab, else prefers the title, then the url without its scheme", () => {
    expect(tabLabel({ title: "  Docs ", url: "https://a.test/docs" })).toBe("Docs");
    expect(tabLabel({ title: "", url: "http://localhost:3000/" })).toBe("localhost:3000");
    expect(tabLabel({ title: "", url: "https://a.test/x?y=1" })).toBe("a.test/x?y=1");
    expect(tabLabel({ title: "", url: "about:blank" })).toBe("New tab");
    expect(tabLabel({ title: "", url: "" })).toBe("New tab");
    expect(tabLabel({ title: "about:blank", url: "about:blank" })).toBe("New tab");
  });
});

describe("faviconOf", () => {
  it("takes the first http(s) icon and nothing else", () => {
    expect(faviconOf(["data:image/png;base64,AAAA", "https://a.test/favicon.ico"])).toBe(
      "https://a.test/favicon.ico",
    );
    expect(faviconOf(["file:///etc/icon.png", "javascript:alert(1)"])).toBeNull();
    expect(faviconOf([`https://a.test/${"x".repeat(2100)}`])).toBeNull();
    expect(faviconOf("https://a.test/favicon.ico")).toBeNull();
    expect(faviconOf(undefined)).toBeNull();
  });
});
