import { describe, expect, it } from "vitest";

import { INSTALL_COMMANDS, isAgentBrowserMissing } from "./install";

/**
 * Kept in step with `AGENT_BROWSER_MISSING_MESSAGE` in
 * `apps/server/src/browser/agentBrowser.ts` — if that sentence is reworded,
 * this is the test that says so.
 */
const SERVER_MESSAGE =
  "agent-browser is not installed. Install it with `npm install -g agent-browser`, " +
  "then run `agent-browser install`.";

describe("isAgentBrowserMissing", () => {
  it("recognises the server's install message", () => {
    expect(isAgentBrowserMissing(SERVER_MESSAGE)).toBe(true);
  });

  it("leaves every other failure to the ordinary error chip", () => {
    expect(isAgentBrowserMissing("the browser pane's webview is gone")).toBe(false);
    expect(isAgentBrowserMissing("Could not locate element @e3")).toBe(false);
    expect(isAgentBrowserMissing(undefined)).toBe(false);
  });

  it("offers both commands the message names", () => {
    const commands = INSTALL_COMMANDS.map((entry) => entry.command);
    for (const command of commands) {
      expect(SERVER_MESSAGE).toContain(command);
    }
  });
});
