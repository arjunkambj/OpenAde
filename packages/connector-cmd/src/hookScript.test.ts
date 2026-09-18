/**
 * The generated `cmd-hook.mjs`, executed by real node. The two environments
 * that matter:
 *
 * - no `OPENADE_HOOK_URL` and no bearer — an interactive `cmd` run in a project
 *   whose settings.local.json still carries our PreToolUse block. The script
 *   must print NO decision and exit 0, or it would deny every tool call for
 *   every interactive run in every project we ever touched.
 * - env configured but the bridge unreachable — an OpenAde session whose
 *   server went away. Deny-on-unreachable stays: a tool that cannot ask must
 *   not run.
 * - the bearer in a ticket file rather than the environment, which is how it
 *   really arrives: Command Code strips secret-shaped variable names out of a
 *   hook's env, and a live run proved it strips `OPENADE_HOOK_TOKEN`.
 */

import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import { hookScriptSource, hookTicketPath, removeHookTicket, writeHookTicket } from "./hookScript";

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
    delete env.OPENADE_HOOK_TICKET_FILE;
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

  /**
   * The path that matters in production. A live run of `cmd` 1.55.1 showed
   * `OPENADE_HOOK_URL` and `OPENADE_THREAD_ID` reaching a hook while
   * `OPENADE_HOOK_TOKEN` did not — the CLI redacts TOKEN, BEARER, SECRET, AUTH,
   * PASSWORD and CREDENTIAL out of the environment it hands a hook. With no
   * bearer the script takes its "no session owns this run" exit, the harness
   * falls back to its own flow, and under `--yolo` every tool call runs
   * unapproved. The bearer therefore arrives in a file.
   */
  it("reads the bearer from the ticket file when the env has been redacted", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-ticket-test-"));
    try {
      const ticket = NodePath.join(dir, "thread.ticket");
      NodeFS.writeFileSync(ticket, "the-bearer\n", { encoding: "utf8", mode: 0o600 });

      const result = runHook({
        OPENADE_HOOK_URL: "http://127.0.0.1:9/hooks/pretooluse",
        OPENADE_HOOK_TICKET_FILE: ticket,
      });
      // It got as far as trying the bridge, which is the whole point: with no
      // bearer it would have exited silently instead.
      expect(result.status).toBe(0);
      const out = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("unreachable");

      // A ticket that is not there is the same as no session at all.
      NodeFS.rmSync(ticket);
      const gone = runHook({
        OPENADE_HOOK_URL: "http://127.0.0.1:9/hooks/pretooluse",
        OPENADE_HOOK_TICKET_FILE: ticket,
      });
      expect(gone.status).toBe(0);
      expect(gone.stdout).toBe("");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ticket file", () => {
  it("is written owner-only and removed with the session", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-ticket-home-"));
    try {
      const env = { OPENADE_HOME: home };
      const path = hookTicketPath("01JQ0000000000000000000000", env);
      expect(path.startsWith(home)).toBe(true);

      Effect.runSync(writeHookTicket(path, "s3cret"));
      expect(NodeFS.readFileSync(path, "utf8")).toBe("s3cret");
      // 0600: the bearer is a credential, and it is at rest.
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);

      Effect.runSync(removeHookTicket(path));
      expect(NodeFS.existsSync(path)).toBe(false);
      // Removing one that is already gone is not an error.
      Effect.runSync(removeHookTicket(path));
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
