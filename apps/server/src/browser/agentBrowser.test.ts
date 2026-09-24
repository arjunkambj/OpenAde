/**
 * The CLI wrapper: the session name, the env one session's invocations run
 * with, the bridge handoff, and the envelope parse.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BRIDGE_ENV, BRIDGE_KEY_ENV, mintLaunchKey } from "@OpenAde/shared/browserBridge";
import { readManifest } from "@OpenAde/testkit/recording";

import {
  AGENT_BROWSER_MISSING_MESSAGE,
  AgentBrowser,
  BROWSER_DISABLED_MESSAGE,
  browserEnv,
  decodeResult,
  makeAgentBrowser,
  modeFor,
  readBridgeConfig,
  sessionEnvFor,
  sessionNameFor,
  takeBridgeConfig,
  type ChildRunner,
} from "./agentBrowser";

const KEY = "a".repeat(64);
const BASE = "ws://127.0.0.1:47000";

/** A runner that records what it was asked to run and answers one envelope. */
const capture = (envelope: unknown = { success: true, data: {}, error: null }) => {
  const runs: Array<{ args: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const run: ChildRunner = (_binary, args, options) =>
    Effect.sync(() => {
      runs.push({ args, env: options.env });
      return { stdout: JSON.stringify(envelope), stderr: "", error: null };
    });
  return { runs, run };
};

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

  it("gives every session an idle timeout", () => {
    // The safety net behind `close`: a daemon the server never closed (it
    // crashed) still reaps itself.
    expect(sessionEnvFor().AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("300000");
  });

  it("hands the child an allowlist, not the server's whole environment", () => {
    // agent-browser is a third-party CLI with a plugin system and an auth
    // vault, and it is the component that then visits untrusted pages.
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

  it("drops the operator's own AGENT_BROWSER_* and CHROME_*", () => {
    // Each of these redirects or loosens the child: another browser to drive,
    // one to go looking for, local files for pages to read.
    const env = browserEnv({
      PATH: "/usr/bin",
      AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/x",
      AGENT_BROWSER_AUTO_CONNECT: "1",
      AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
      AGENT_BROWSER_CONFIG: "/tmp/evil.json",
      CHROME_PATH: "/tmp/not-chrome",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("will not let the extra env smuggle a name the list refuses", () => {
    const env = browserEnv({}, { ANTHROPIC_API_KEY: "sk-test", AGENT_BROWSER_PROFILE: "work" });
    expect(env).toEqual({ AGENT_BROWSER_PROFILE: "work" });
  });

  describe("the bridge handoff", () => {
    it("reads a bridge, the kill switch, or nothing", () => {
      expect(readBridgeConfig({ [BRIDGE_ENV]: BASE, [BRIDGE_KEY_ENV]: KEY })).toEqual({
        base: BASE,
        key: KEY,
      });
      expect(readBridgeConfig({ [BRIDGE_ENV]: "disabled" })).toBe("disabled");
      expect(readBridgeConfig({})).toBeNull();
      expect(modeFor({ base: BASE, key: KEY })).toBe("in-app");
      expect(modeFor("disabled")).toBe("disabled");
      expect(modeFor(null)).toBe("owned-chromium");
    });

    it("treats an unusable handoff as disabled, never as no desktop", () => {
      // `null` would mean owned Chromium: a desktop quietly driving a headless
      // browser the user cannot see.
      for (const env of [
        { [BRIDGE_ENV]: BASE },
        { [BRIDGE_ENV]: BASE, [BRIDGE_KEY_ENV]: "short" },
        { [BRIDGE_ENV]: "ws://10.0.0.5:47000", [BRIDGE_KEY_ENV]: KEY },
        { [BRIDGE_ENV]: "ws://127.0.0.1", [BRIDGE_KEY_ENV]: KEY },
      ]) {
        expect(readBridgeConfig(env)).toBe("disabled");
      }
    });

    it("takes the launch key out of the environment it read it from", () => {
      const env: Record<string, string | undefined> = {
        [BRIDGE_ENV]: BASE,
        [BRIDGE_KEY_ENV]: KEY,
        OPENADE_HOME: "/tmp/home",
      };
      expect(takeBridgeConfig(env)).toEqual({ base: BASE, key: KEY });
      expect(env).toEqual({ OPENADE_HOME: "/tmp/home" });
    });

    it.effect("the layer removes the handoff from process.env", () =>
      Effect.gen(function* () {
        const key = mintLaunchKey();
        const saved = { ...process.env };
        process.env[BRIDGE_ENV] = BASE;
        process.env[BRIDGE_KEY_ENV] = key;
        // A binary that is not there: the probe fails fast and harmlessly.
        process.env.OPENADE_AGENT_BROWSER = "/nonexistent/agent-browser";
        try {
          const agentBrowser = yield* Effect.scoped(
            Layer.build(AgentBrowser.layer).pipe(
              Effect.map((context) => Context.get(context, AgentBrowser)),
            ),
          );
          expect(agentBrowser.mode).toBe("in-app");
          expect(process.env[BRIDGE_ENV]).toBeUndefined();
          expect(process.env[BRIDGE_KEY_ENV]).toBeUndefined();
          expect(JSON.stringify(process.env)).not.toContain(key);
        } finally {
          for (const name of [BRIDGE_ENV, BRIDGE_KEY_ENV, "OPENADE_AGENT_BROWSER"]) {
            delete process.env[name];
            if (saved[name] !== undefined) process.env[name] = saved[name];
          }
        }
      }),
    );
  });

  describe("a session", () => {
    it.effect("in-app, carries its bridge URL in the child's env and never in argv", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: { base: BASE, key: KEY },
          env: {
            PATH: "/usr/bin",
            AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/operator",
            AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
          },
          run,
        });
        yield* agentBrowser.session("thread-1").exec(["get", "title"]);

        const [only] = runs;
        expect(only?.args).toEqual(["--session", "ade-thread-1", "--json", "get", "title"]);
        expect(only?.env.AGENT_BROWSER_CDP).toMatch(
          /^ws:\/\/127\.0\.0\.1:47000\/cdp\/thread-1\/[0-9a-f]{64}$/,
        );
        // The operator's own values are gone, not merely overridden.
        expect(only?.env.AGENT_BROWSER_ALLOW_FILE_ACCESS).toBeUndefined();
        expect(only?.env.AGENT_BROWSER_CDP).not.toContain("9222");
      }),
    );

    it.effect("owned, runs with no CDP endpoint at all", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: null,
          env: { PATH: "/usr/bin", AGENT_BROWSER_CDP: "9222" },
          run,
        });
        expect(agentBrowser.mode).toBe("owned-chromium");
        yield* agentBrowser.session("thread-1").exec(["open"]);
        expect(runs[0]?.env.AGENT_BROWSER_CDP).toBeUndefined();
      }),
    );

    it.effect("disabled, answers the kill switch and runs nothing", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: "disabled",
          run,
        });
        const failed = yield* agentBrowser
          .session("thread-1")
          .exec(["tab", "list"])
          .pipe(Effect.flip);
        expect(failed.message).toBe(BROWSER_DISABLED_MESSAGE);
        expect(runs).toEqual([]);
      }),
    );
  });

  it.effect("classifies the real tab_gone envelope, which carries no data.code", () =>
    Effect.gen(function* () {
      const manifest = readManifest<{
        steps: ReadonlyArray<{ argv?: ReadonlyArray<string>; envelope?: { success: boolean } }>;
      }>("agent-browser", "cli-tab-gone");
      const gone = manifest.steps.find((step) => step.envelope?.success === false);
      const failed = yield* decodeResult("agent-browser get title", {
        stdout: JSON.stringify(gone?.envelope),
        stderr: "",
        error: "Command failed",
      }).pipe(Effect.flip);
      expect(failed.code).toBe("tab_gone");
      expect(failed.data).toMatchObject({ lastUrl: "http://127.0.0.1:<SITE_PORT>/" });
    }),
  );
});
