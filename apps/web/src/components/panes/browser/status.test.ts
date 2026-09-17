import { describe, expect, it } from "vitest";

import { makeThreadId } from "@OpenAde/contracts/ids";
import type { BrowserState } from "@OpenAde/contracts/rpc";

import { browserStatus, frameFallback } from "./status";

const base: BrowserState = {
  threadId: makeThreadId(),
  status: "ready",
  mode: "owned-chromium",
  url: "https://example.com/docs",
  title: "Docs",
  frame: null,
};

describe("browserStatus", () => {
  it("shows the host when nothing is driving", () => {
    expect(browserStatus(base).label).toBe("example.com");
  });

  it("names the tool while a browser_* call runs", () => {
    const chip = browserStatus({ ...base, activeTool: "browser_click" });
    expect(chip.label).toBe("agent: browser_click");
    expect(chip.dot).toContain("animate-pulse");
  });

  it("goes back to the page once the call settles", () => {
    // The service writes `activeTool: null` on release — not `undefined`.
    expect(browserStatus({ ...base, activeTool: null }).label).toBe("example.com");
  });

  it("reports starting, errors and stopped sessions", () => {
    expect(browserStatus({ ...base, status: "starting" }).label).toBe("starting");
    expect(browserStatus({ ...base, status: "error", message: "boom" }).label).toBe("boom");
    expect(browserStatus({ ...base, status: "stopped", activeTool: null }).label).toBe("stopped");
    expect(browserStatus(null).label).toBe("connecting");
  });
});

describe("frameFallback", () => {
  const state = (over: Partial<BrowserState>): BrowserState => ({
    threadId: makeThreadId(),
    status: "stopped",
    mode: "owned-chromium",
    url: null,
    title: null,
    frame: null,
    ...over,
  });

  it("does not tell a stopped browser it is starting", () => {
    // The chip beside this said "stopped" while the surface said "starting…".
    expect(frameFallback(state({ status: "stopped" }))).toBe(
      "not running — it starts on the first agent call",
    );
  });

  it("names each of the other states", () => {
    expect(frameFallback(state({ status: "starting" }))).toBe("starting…");
    expect(frameFallback(state({ status: "ready" }))).toBe("waiting for first frame…");
    expect(frameFallback(state({ status: "error" }))).toBe("the browser could not start");
  });

  it("prefers the server's own message when it sent one", () => {
    expect(frameFallback(state({ status: "error", message: "agent-browser not found" }))).toBe(
      "agent-browser not found",
    );
  });
});
