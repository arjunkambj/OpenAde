import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { replay } from "../test/replay";
import { childEnv, expandHome } from "./env";
import { makeProcessGroup, type ClaudeSpawnOptions } from "./spawn";

/**
 * What Poseidon inherits when it is started from inside a Claude Code session:
 * the names are the ones such a process really carries, the values are ours.
 */
const PARENT_SESSION: Readonly<Record<string, string>> = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "parent-entrypoint",
  CLAUDE_CODE_SESSION_ID: "parent-session-id",
  CLAUDE_CODE_OAUTH_SCOPES: "parent-oauth-scopes",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-messaging-token",
  CLAUDE_AGENT_SDK_VERSION: "parent-sdk-version",
  ANTHROPIC_BASE_URL: "https://parent.invalid",
  ANTHROPIC_API_KEY: "parent-api-key",
  CLAUDE_CONFIG_DIR: "/parent/config",
  POSEIDON_SERVER_TOKEN: "server-token",
};

const INHERITED: Readonly<Record<string, string>> = {
  HOME: "/Users/me",
  PATH: "/usr/bin:/bin",
  USER: "me",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TMPDIR: "/tmp",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  HTTPS_PROXY: "http://proxy:8080",
  GH_TOKEN: "unrelated-token",
  NODE_OPTIONS: "--inspect",
  ...PARENT_SESSION,
};

describe("childEnv", () => {
  it("keeps only the allowlisted names", () => {
    expect(childEnv(INHERITED, {})).toEqual({
      HOME: "/Users/me",
      PATH: "/usr/bin:/bin",
      USER: "me",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTPS_PROXY: "http://proxy:8080",
    });
  });

  it("strips every variable of a parent Claude Code session", () => {
    const env = childEnv(INHERITED, {});
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|ANTHROPIC_)/);
    }
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("sets CLAUDE_CONFIG_DIR from the instance and never moves HOME", () => {
    const env = childEnv(INHERITED, { configDir: "/Users/me/.claude-work" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    expect(env.HOME).toBe("/Users/me");
  });

  it("expands a config directory under ~ against the inherited HOME", () => {
    expect(childEnv(INHERITED, { configDir: "~/.claude-work" }).CLAUDE_CONFIG_DIR).toBe(
      "/Users/me/.claude-work",
    );
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("relative/dir", "/h")).toBe(NodePath.resolve("relative/dir"));
  });

  it("reaches the CLI unchanged through the SDK, with no parent session variable", async () => {
    // The probe recording's handshake stands in for the CLI: the SDK builds
    // the child's environment from the `env` option and hands it to the spawn.
    const { binaryPath } = replay("probe");
    const group = makeProcessGroup();
    let seen: ClaudeSpawnOptions["env"] = {};
    const abort = new AbortController();
    const never: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) =>
            abort.signal.addEventListener("abort", () => resolve({ done: true, value: undefined })),
          ),
      }),
    };
    const env = childEnv(
      { ...INHERITED, HOME: NodeOS.homedir(), PATH: process.env.PATH ?? "" },
      {},
    );
    const session = query({
      prompt: never,
      options: {
        pathToClaudeCodeExecutable: binaryPath,
        env,
        cwd: NodeOS.tmpdir(),
        abortController: abort,
        settingSources: [],
        persistSession: false,
        spawnClaudeCodeProcess: (options) => {
          seen = options.env;
          return group.spawn(options);
        },
      },
    });
    await session.initializationResult();
    abort.abort();
    await Effect.runPromise(group.stop);

    // Ours, plus the two the SDK sets for its own child, with its own values.
    expect(Object.keys(seen).sort()).toEqual(
      [...Object.keys(env), "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"].sort(),
    );
    expect(seen.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");

    const parentValues = new Set(Object.values(PARENT_SESSION));
    for (const [name, value] of Object.entries(seen)) {
      expect(parentValues.has(value ?? ""), name).toBe(false);
    }
    expect(seen.CLAUDECODE).toBeUndefined();
    expect(Object.keys(seen).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(seen.HOME).toBe(NodeOS.homedir());
  });
});
