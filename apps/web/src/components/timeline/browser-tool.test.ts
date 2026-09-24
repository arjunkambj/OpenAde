import { describe, expect, it } from "vitest";

import { browserToolLabel } from "./browser-tool";

const label = (tool: string, input: unknown = {}) =>
  browserToolLabel(`mcp__poseidon__browser_${tool}`, input);

describe("browserToolLabel", () => {
  it("says what the agent did to the page", () => {
    expect(label("open", { url: "http://localhost:5173/" })).toBe("Opened http://localhost:5173/");
    expect(label("snapshot", { interactive: true })).toBe("Read the page's controls");
    expect(label("snapshot")).toBe("Read the page");
    expect(label("click", { selector: "@e3" })).toBe("Clicked @e3");
    expect(label("fill", { selector: "@e2", text: "secret" })).toBe("Filled @e2");
    expect(label("type", { text: "hello" })).toBe("Typed text");
    expect(label("press", { key: "Enter" })).toBe("Pressed Enter");
    expect(label("scroll", { direction: "up", px: 200 })).toBe("Scrolled up 200px");
    expect(label("scroll")).toBe("Scrolled down");
    expect(label("wait", { text: "Saved" })).toBe("Waited for Saved");
    expect(label("wait", { fn: "window.ready" })).toBe("Waited for a condition");
    expect(label("wait", { ms: 500 })).toBe("Waited 500 ms");
    expect(label("get", { what: "title" })).toBe("Read the page title");
    expect(label("get", { what: "text", selector: "h1" })).toBe("Read the text of h1");
    expect(label("screenshot")).toBe("Took a screenshot");
    expect(label("screenshot", { full: true })).toBe("Took a full-page screenshot");
    expect(label("eval", { js: "document.title" })).toBe("Ran JavaScript in the page");
    expect(label("tabs", { action: "new", url: "https://a.test/" })).toBe(
      "Opened a new tab https://a.test/",
    );
    expect(label("tabs", { action: "switch", tab: "t2" })).toBe("Switched to tab t2");
    expect(label("tabs", { action: "close" })).toBe("Closed a tab");
    expect(label("tabs", { action: "list" })).toBe("Listed the tabs");
  });

  it("never echoes what the agent typed", () => {
    expect(label("type", { text: "hunter2" })).not.toContain("hunter2");
    expect(label("fill", { selector: "#pw", text: "hunter2" })).not.toContain("hunter2");
  });

  it("cuts a long target to one short line", () => {
    const url = `https://example.com/${"a".repeat(100)}\nsecond`;
    const shown = label("open", { url });
    expect(shown?.endsWith("…")).toBe(true);
    expect(shown).not.toContain("second");
  });

  it("leaves other tools alone", () => {
    expect(browserToolLabel("mcp__github__create_issue", {})).toBe(null);
    expect(browserToolLabel("mcp__poseidon__browser_teleport", {})).toBe(null);
    expect(browserToolLabel("read_file", {})).toBe(null);
  });
});
