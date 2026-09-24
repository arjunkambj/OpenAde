import { describe, expect, it } from "vitest";

import { BROWSER_DISABLED_LABEL } from "@/components/panes/browser/status";

import { modeLabel, statusLabel } from "./browser-status";

describe("the Browser page's status words", () => {
  it("shows agent-browser's version, or that it is missing", () => {
    expect(statusLabel({ mode: "in-app", installed: true, version: "agent-browser 0.38.1" })).toBe(
      "agent-browser 0.38.1",
    );
    expect(statusLabel({ mode: "in-app", installed: true, version: null })).toBe("Installed");
    expect(statusLabel({ mode: "owned-chromium", installed: false, version: null })).toBe(
      "Not installed",
    );
  });

  it("names the browser the agent drives on this run", () => {
    const status = { installed: true, version: null } as const;
    expect(modeLabel({ ...status, mode: "in-app" })).toBe("Drives the in-app browser");
    expect(modeLabel({ ...status, mode: "owned-chromium" })).toBe("Headless browser (web mode)");
    expect(modeLabel({ ...status, mode: "disabled" })).toBe(BROWSER_DISABLED_LABEL);
  });
});
