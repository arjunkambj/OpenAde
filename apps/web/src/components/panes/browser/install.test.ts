import { describe, expect, it } from "vitest";

import { installCommands, isAgentBrowserMissing } from "./install";

/**
 * Kept in step with `agentBrowserMissingMessage` in
 * `apps/server/src/browser/agentBrowser.ts` — if that sentence is reworded,
 * this is the test that says so.
 */
const SERVER_MESSAGE = {
  "in-app": "agent-browser is not installed. Install it with `npm install -g agent-browser`.",
  "owned-chromium":
    "agent-browser is not installed. Install it with `npm install -g agent-browser`, " +
    "then run `agent-browser install` to download the browser it drives.",
} as const;

describe("isAgentBrowserMissing", () => {
  it("recognises the server's install message in either mode", () => {
    expect(isAgentBrowserMissing(SERVER_MESSAGE["in-app"])).toBe(true);
    expect(isAgentBrowserMissing(SERVER_MESSAGE["owned-chromium"])).toBe(true);
  });

  it("leaves every other failure to the ordinary error chip", () => {
    expect(isAgentBrowserMissing("the browser pane's webview is gone")).toBe(false);
    expect(isAgentBrowserMissing("Could not locate element @e3")).toBe(false);
    expect(isAgentBrowserMissing(undefined)).toBe(false);
  });
});

describe("installCommands", () => {
  it("asks the in-app browser for the CLI only — it downloads no Chrome", () => {
    expect(installCommands("in-app").map((entry) => entry.command)).toEqual([
      "npm install -g agent-browser",
    ]);
  });

  it("adds the Chrome download for the web renderer's headless browser", () => {
    expect(installCommands("owned-chromium").map((entry) => entry.command)).toEqual([
      "npm install -g agent-browser",
      "agent-browser install",
    ]);
  });

  it("offers exactly the commands the server's sentence names", () => {
    for (const mode of ["in-app", "owned-chromium"] as const) {
      const sentence = SERVER_MESSAGE[mode];
      for (const { command } of installCommands(mode)) {
        expect(sentence).toContain(`\`${command}\``);
      }
      expect(sentence.match(/`[^`]+`/g)).toHaveLength(installCommands(mode).length);
    }
  });
});
