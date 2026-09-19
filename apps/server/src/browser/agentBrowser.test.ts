/**
 * The bits of the CLI wrapper that are pure: the session name and the env one
 * session's invocations run with.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_BROWSER_MISSING_MESSAGE,
  browserEnv,
  sessionEnvFor,
  sessionNameFor,
} from "./agentBrowser";

describe("agentBrowser", () => {
  it("tells the user exactly what to run when the binary is missing", () => {
    // The pane keys its install prompt off this opening clause and prints the
    // same two commands.
    expect(AGENT_BROWSER_MISSING_MESSAGE.startsWith("agent-browser is not installed")).toBe(true);
    expect(AGENT_BROWSER_MISSING_MESSAGE).toContain("npm install -g agent-browser");
    expect(AGENT_BROWSER_MISSING_MESSAGE).toContain("agent-browser install");
  });

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

  it("hands the child an allowlist, not the server's whole environment", () => {
    // agent-browser is a third-party CLI with a plugin system and an auth
    // vault, and it is the component that then visits untrusted pages. It used
    // to inherit `process.env` whole — including the very prefixes the
    // connector's own spawn guard drops on purpose.
    const env = browserEnv(
      {
        HOME: "/Users/someone",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.internal:3128",
        DISPLAY: ":0",
        LC_ALL: "en_GB.UTF-8",
        ANTHROPIC_API_KEY: "sk-test-1234",
        OPENAI_API_KEY: "sk-test-5678",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GITHUB_TOKEN: "ghp_test",
        COMMAND_CODE_API_KEY: "cc-secret",
        OPENADE_SERVER_TOKEN: "server-token",
        OPENADE_HOME: "/Users/someone/.openade",
      },
      sessionEnvFor(),
    );

    expect(env).toEqual({
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      DISPLAY: ":0",
      LC_ALL: "en_GB.UTF-8",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
    });
  });

  it("will not let the extra env smuggle a name the list refuses", () => {
    const env = browserEnv({}, { ANTHROPIC_API_KEY: "sk-test", AGENT_BROWSER_PROFILE: "work" });
    expect(env).toEqual({ AGENT_BROWSER_PROFILE: "work" });
  });
});
