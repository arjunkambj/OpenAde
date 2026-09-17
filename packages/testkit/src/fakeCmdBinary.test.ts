/**
 * The standalone `fake-cmd.mjs` executable, run as a real process.
 *
 * The connector's own suites drive it through `makeCmdSession`; this file pins
 * the CLI surface itself — the parts a probe and a human both rely on — so a
 * change to the fake that breaks `status --json` or `--list-models` fails here
 * rather than as a mystery in the connector.
 */

import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const BINARY = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../bin/fake-cmd.mjs");

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
}

const sandbox = (): Effect.Effect<Sandbox, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Sandbox => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-cmd-test-"));
      const home = NodePath.join(root, "home");
      const workspace = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.mkdirSync(workspace, { recursive: true });
      return { root, home, workspace };
    }),
    (box) => Effect.sync(() => NodeFS.rmSync(box.root, { recursive: true, force: true })),
  );

const run = (box: Sandbox, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  spawnSync(BINARY, [...args], {
    cwd: box.workspace,
    encoding: "utf8",
    env: { ...process.env, HOME: box.home, ...env },
  });

const frames = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const transcriptOf = (box: Sandbox, sessionId: string): Array<Record<string, unknown>> => {
  const slug = NodeFS.realpathSync(box.workspace)
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/^-/, "");
  const path = NodePath.join(box.home, ".commandcode", "projects", slug, `${sessionId}.jsonl`);
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("fake-cmd.mjs", () => {
  it.effect("answers status --json, --list-models and --version", () =>
    Effect.gen(function* () {
      const box = yield* sandbox();

      const status = JSON.parse(run(box, ["status", "--json"]).stdout) as {
        authenticated: boolean;
        version: string;
      };
      expect(status.authenticated).toBe(true);
      expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);

      const models = run(box, ["--list-models"]).stdout;
      expect(models).toContain("deepseek/deepseek-v4-flash");
      expect(models).toContain("(default)");

      expect(run(box, ["--version"]).stdout.trim()).toBe(status.version);
      expect(run(box, ["--help"]).stdout).toContain("--output-format");
    }),
  );

  it.effect("runs a print-mode turn and writes the spec 5.3 transcript", () =>
    Effect.gen(function* () {
      const box = yield* sandbox();
      const sessionId = "0000-turn";
      const result = run(box, ["-p", "hello", "--output-format", "json", "--verbose", "--yolo"], {
        OPENADE_FAKE_SESSION_ID: sessionId,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`session: ${sessionId}`);
      const lines = frames(result.stdout);
      expect(lines.map((line) => line.type)).toEqual([
        "event",
        "event",
        "event",
        "event",
        "event",
        "result",
      ]);
      const events = lines
        .filter((line) => line.type === "event")
        .map((line) => (line.event as { type: string }).type);
      expect(events).toEqual([
        "run_start",
        "turn_start",
        "message_start",
        "model_request_start",
        "run_end",
      ]);

      const transcript = transcriptOf(box, sessionId);
      expect(transcript[0]).toMatchObject({ type: "session", version: 3, id: sessionId });
      expect(transcript).toHaveLength(3); // header, the prompt, the answer
    }),
  );

  it.effect("appends to an existing transcript when --session resumes", () =>
    Effect.gen(function* () {
      const box = yield* sandbox();
      const sessionId = "0000-resume";
      const args = ["-p", "hello", "--output-format", "json", "--verbose", "--yolo"];
      run(box, args, { OPENADE_FAKE_SESSION_ID: sessionId });
      run(box, [...args, "--session", sessionId]);

      const transcript = transcriptOf(box, sessionId);
      // One header, then two prompts and two answers.
      expect(transcript.filter((line) => line.type === "session")).toHaveLength(1);
      expect(transcript).toHaveLength(5);
    }),
  );

  it.effect("calls the installed PreToolUse hook and obeys a deny", () =>
    Effect.gen(function* () {
      const box = yield* sandbox();
      const hook = NodePath.join(box.root, "hook.mjs");
      NodeFS.writeFileSync(
        hook,
        `#!/usr/bin/env node
import * as fs from "node:fs";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.HOOK_LOG, data);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not today" },
  }) + "\\n");
});
`,
        { mode: 0o700 },
      );
      NodeFS.mkdirSync(NodePath.join(box.workspace, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(box.workspace, ".commandcode", "settings.local.json"),
        JSON.stringify({
          hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: hook }] }] },
        }),
      );

      const log = NodePath.join(box.root, "hook.json");
      const result = run(
        box,
        ["-p", "run a shell command", "--output-format", "json", "--verbose", "--yolo"],
        { HOOK_LOG: log, OPENADE_FAKE_SESSION_ID: "0000-hook" },
      );

      const payload = JSON.parse(NodeFS.readFileSync(log, "utf8")) as {
        hook_event_name: string;
        tool_name: string;
        tool_input: { command: string };
      };
      expect(payload.hook_event_name).toBe("PreToolUse");
      expect(payload.tool_name).toBe("shell_command");
      expect(payload.tool_input.command).toContain("echo");
      // The denial reaches the transcript as a failed tool result.
      expect(result.stdout).toContain("not today");
    }),
  );

  it.effect("writes a plan file and its index entry in plan mode", () =>
    Effect.gen(function* () {
      const box = yield* sandbox();
      run(
        box,
        ["-p", "make a plan", "--output-format", "json", "--verbose", "--permission-mode", "plan"],
        { OPENADE_FAKE_SESSION_ID: "0000-plan" },
      );

      const plansDir = NodePath.join(box.home, ".commandcode", "plans");
      const index = JSON.parse(
        NodeFS.readFileSync(NodePath.join(plansDir, "plans-index.json"), "utf8"),
      ) as { plans: Record<string, { sessionId: string }> };
      const [file, entry] = Object.entries(index.plans)[0]!;
      expect(entry.sessionId).toBe("0000-plan");
      expect(NodeFS.readFileSync(NodePath.join(plansDir, file), "utf8")).toContain("# Plan for:");
    }),
  );
});
