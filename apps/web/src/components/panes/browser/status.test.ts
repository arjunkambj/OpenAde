import { describe, expect, it } from "vitest";

import { makeThreadId } from "@OpenAde/contracts/ids";
import type { BrowserState } from "@OpenAde/contracts/rpc";

import { BROWSER_DISABLED_LABEL, browserModeLabel, browserStatus, frameFallback } from "./status";

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

  it("colours the dot with theme tokens, never a raw palette colour", () => {
    expect(browserStatus(base).dot).toBe("bg-added");
    expect(browserStatus({ ...base, activeTool: "browser_click" }).dot).toBe(
      "bg-permission animate-pulse",
    );
    expect(browserStatus({ ...base, status: "starting" }).dot).toBe("bg-permission animate-pulse");
    expect(browserStatus({ ...base, status: "error", message: "boom" }).dot).toBe("bg-destructive");
    expect(browserStatus({ ...base, status: "stopped" }).dot).toBe("bg-muted-foreground");
    expect(browserStatus(null).dot).toBe("bg-muted-foreground");
    const every = [
      base,
      { ...base, activeTool: "browser_click" },
      { ...base, status: "starting" as const },
      { ...base, status: "error" as const },
      { ...base, status: "stopped" as const },
      { ...base, mode: "disabled" as const },
    ].map((state) => browserStatus(state).dot);
    for (const dot of every) {
      expect(dot).not.toMatch(/-(amber|emerald|red|green|yellow)-\d/);
    }
  });

  it("says disabled under the kill switch, whatever the status", () => {
    const chip = browserStatus({ ...base, mode: "disabled", status: "stopped" });
    expect(chip.label).toBe("disabled");
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
    // `browser-pane.tsx` renders this branch itself for a stopped session, so
    // there is one copy of the sentence rather than an inline second one.
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

describe("browserModeLabel", () => {
  it("labels the web renderer's headless browser and the kill switch", () => {
    expect(browserModeLabel("owned-chromium")).toBe("Headless browser (web mode)");
    expect(browserModeLabel("disabled")).toBe(
      "In-app browser is disabled (OPENADE_REMOTE_DEBUG=0)",
    );
    expect(BROWSER_DISABLED_LABEL).toBe(browserModeLabel("disabled"));
  });

  it("says nothing for the ordinary in-app browser", () => {
    expect(browserModeLabel("in-app")).toBeNull();
  });
});
