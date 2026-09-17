/**
 * The bits of the CLI wrapper that are pure: the session name and the env one
 * session's invocations run with.
 */

import { describe, expect, it } from "vitest";

import { sessionEnvFor, sessionNameFor } from "./agentBrowser";

describe("agentBrowser", () => {
  it("names a thread's daemon session", () => {
    expect(sessionNameFor("t-1")).toBe("ade-t-1");
  });

  it("gives every session an idle timeout, cdp attachments included", () => {
    // A cdp session's driver.close is a no-op on purpose (closing it would
    // destroy the pane's webview), so the timeout is the only thing that ever
    // reaps the `ade-<threadId>` daemon.
    expect(sessionEnvFor().AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("300000");
  });

  it("lets a caller override the env it sets", () => {
    const env = sessionEnvFor({ AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000", OTHER: "x" });
    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("1000");
    expect(env.OTHER).toBe("x");
  });
});
