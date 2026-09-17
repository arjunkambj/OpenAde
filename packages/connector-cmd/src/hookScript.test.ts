/**
 * The generated `cmd-hook.mjs`, executed by real node. The two environments
 * that matter:
 *
 * - no `OPENADE_HOOK_URL`/`OPENADE_HOOK_TOKEN` — an interactive `cmd` run in a
 *   project whose settings.local.json still carries our PreToolUse block. The
 *   script must print NO decision and exit 0, or it would deny every tool call
 *   for every interactive run in every project we ever touched.
 * - env configured but the bridge unreachable — an OpenAde session whose
 *   server went away. Deny-on-unreachable stays: a tool that cannot ask must
 *   not run.
 */

import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { hookScriptSource } from "./hookScript";

const HOOK_PAYLOAD = JSON.stringify({
  session_id: "sess-1",
  hook_event_name: "PreToolUse",
  tool_name: "shell_command",
  tool_input: { command: "rm -rf build" },
  cwd: "/tmp",
});

const runHook = (
  extraEnv: Readonly<Record<string, string>>,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-hook-test-"));
  try {
    const script = NodePath.join(dir, "cmd-hook.mjs");
    NodeFS.writeFileSync(script, hookScriptSource(), "utf8");
    const env = { ...process.env };
    delete env.OPENADE_HOOK_URL;
    delete env.OPENADE_HOOK_TOKEN;
    const result = spawnSync(process.execPath, [script], {
      input: HOOK_PAYLOAD,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("cmd-hook.mjs under real node", () => {
  it("emits NO decision when the OpenAde env is absent", () => {
    const result = runHook({});
    expect(result.status).toBe(0);
    // No hookSpecificOutput — the harness falls back to its own prompt flow.
    expect(result.stdout).toBe("");
  });

  it("emits NO decision when only the token is missing", () => {
    const result = runHook({ OPENADE_HOOK_URL: "http://127.0.0.1:9/hooks/pretooluse" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("still denies when the env is set but the bridge is unreachable", () => {
    const result = runHook({
      // Port 9 is the discard service — nothing listens, so the fetch fails fast.
      OPENADE_HOOK_URL: "http://127.0.0.1:9/hooks/pretooluse",
      OPENADE_HOOK_TOKEN: "t",
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
