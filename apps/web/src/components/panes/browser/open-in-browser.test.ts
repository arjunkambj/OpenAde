import { describe, expect, it } from "vitest";

import { makeThreadId, type ThreadId } from "@poseidon/contracts/ids";
import { AtomRegistry } from "effect/unstable/reactivity";

import { updateBrowserTabs, type BrowserTabsState } from "@/state/browser-tabs";

import { openInThreadBrowserWith, openOrSelect, webUrlOf } from "./open-in-browser";

const threadId = makeThreadId();

const harness = (hostsTabs: boolean) => {
  const registry = AtomRegistry.make();
  const headless: Array<{ threadId: ThreadId; url: string }> = [];
  let tabs: BrowserTabsState = {};
  const env = {
    registry,
    hostsTabs,
    navigateHeadless: (id: ThreadId, url: string) => headless.push({ threadId: id, url }),
  };
  const readTabs = () => {
    updateBrowserTabs(registry, (state) => {
      tabs = state;
      return state;
    });
    return tabs;
  };
  return { env, headless, readTabs };
};

describe("webUrlOf", () => {
  it("accepts http and https pages", () => {
    expect(webUrlOf("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(webUrlOf(" https://example.com/a?b=c ")).toBe("https://example.com/a?b=c");
  });

  it("rejects every other scheme and anything that is not a url", () => {
    for (const raw of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
      "ftp://example.com/",
      "localhost:3000",
      "",
    ]) {
      expect(webUrlOf(raw), raw).toBeNull();
    }
  });
});

describe("openInThreadBrowser", () => {
  it("rejects a non-http(s) url and opens nothing", () => {
    const { env, headless, readTabs } = harness(true);
    const result = openInThreadBrowserWith(env, threadId, "file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(readTabs()).toEqual({});
    expect(headless).toEqual([]);
    const web = harness(false);
    expect(openInThreadBrowserWith(web.env, threadId, "javascript:alert(1)").ok).toBe(false);
    expect(web.headless).toEqual([]);
  });

  it("opens a selected human tab on the desktop", () => {
    const { env, headless, readTabs } = harness(true);
    const result = openInThreadBrowserWith(env, threadId, "http://localhost:5173/");
    expect(result).toEqual({ ok: true, url: "http://localhost:5173/" });
    const thread = readTabs()[threadId];
    expect(thread?.tabs).toHaveLength(1);
    expect(thread?.tabs[0]?.openedBy).toBe("human");
    expect(thread?.selected).toBe(thread?.tabs[0]?.tabId);
    expect(headless).toEqual([]);
  });

  it("selects the tab already on the url instead of opening another", () => {
    const { env, readTabs } = harness(true);
    openInThreadBrowserWith(env, threadId, "http://localhost:5173/");
    openInThreadBrowserWith(env, threadId, "http://localhost:3000/");
    openInThreadBrowserWith(env, threadId, "http://localhost:5173/");
    const thread = readTabs()[threadId];
    expect(thread?.tabs.map((tab) => tab.url)).toEqual([
      "http://localhost:5173/",
      "http://localhost:3000/",
    ]);
    expect(thread?.selected).toBe(thread?.tabs[0]?.tabId);
  });

  it("navigates the headless browser in the web renderer", () => {
    const { env, headless, readTabs } = harness(false);
    openInThreadBrowserWith(env, threadId, "https://example.com/");
    expect(headless).toEqual([{ threadId, url: "https://example.com/" }]);
    expect(readTabs()).toEqual({});
  });
});

describe("openOrSelect", () => {
  it("keeps other threads' tabs apart", () => {
    const other = makeThreadId();
    const state = openOrSelect(
      openOrSelect({}, other, "https://a.test/"),
      threadId,
      "https://a.test/",
    );
    expect(state[other]?.tabs).toHaveLength(1);
    expect(state[threadId]?.tabs).toHaveLength(1);
  });
});
