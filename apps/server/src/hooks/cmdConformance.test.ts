/**
 * `runConnectorConformance` against the real `cmdConnectorDefinition`.
 *
 * Command Code itself is unusable here — the account has no credits
 * (docs/decisions/w2-cmd-frames.md) — so the "process" is a generated node
 * script that speaks the harness's NDJSON protocol for real: frames on stdout,
 * a transcript appended under a temp `HOME`, a pid file so the suite's
 * `isProcessGone` check inspects real children, and for the approval turn a
 * real `fetch` POST to a real `HookBridge` on a real bound port — the same
 * round trip `cmd-hook.mjs` makes in production.
 *
 * Nothing touches the real `~/.commandcode` or `~/.openade`: `OPENADE_HOME` is
 * redirected for the duration of this file.
 */

import { createServer } from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { afterAll } from "vitest";
import { runConnectorConformance } from "@OpenAde/connector-sdk/conformance";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { cmdConnectorDefinition } from "@OpenAde/connector-cmd/definition";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { HookBridge } from "./HookBridge";

const TMP = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-conformance-"));
const HOME_DIR = NodePath.join(TMP, "home");
const WORKSPACE = NodePath.join(TMP, "workspace");
const PID_DIR = NodePath.join(TMP, "pids");
const SESSION_ID = "00000000-0000-7000-8000-0c0nf0rm0001";
NodeFS.mkdirSync(HOME_DIR, { recursive: true });
NodeFS.mkdirSync(WORKSPACE, { recursive: true });
NodeFS.mkdirSync(PID_DIR, { recursive: true });

const previousOpenadeHome = process.env.OPENADE_HOME;
process.env.OPENADE_HOME = NodePath.join(TMP, "openade");

const FAKE_CMD = `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const sessionId = process.env.OPENADE_FAKE_SESSION_ID;
const home = process.env.HOME;
const cwd = process.cwd();
const pidDir = process.env.OPENADE_FAKE_PID_DIR;
if (pidDir) {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(path.join(pidDir, String(process.pid)), "");
}
const argv = process.argv.slice(2);
const p = argv.indexOf("-p");
const prompt = p >= 0 ? argv[p + 1] ?? "" : "";
const slug = cwd.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
const dir = path.join(home, ".commandcode", "projects", slug);
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sessionId + ".jsonl");
const emit = (event) =>
  process.stdout.write(JSON.stringify({ type: "event", event }) + "\\n");
fs.writeFileSync(
  transcript,
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\\n",
);
process.on("SIGINT", () => process.exit(130));
emit({ type: "run_start", sessionId });
emit({ type: "turn_start", turnNumber: 1 });
emit({ type: "model_request_start", model: "fake/model" });
const stamp = Date.now();
const userMessage = {
  role: "user",
  content: [{ type: "text", text: prompt }],
  meta: { source: "user", createdAt: 1, messageId: "u-" + stamp },
};
const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  meta: { source: "model", createdAt: 2, messageId: "a-" + stamp },
};
let decision = null;
if (prompt.includes("approve") && process.env.OPENADE_HOOK_URL) {
  try {
    const res = await fetch(process.env.OPENADE_HOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + process.env.OPENADE_HOOK_TOKEN,
      },
      body: JSON.stringify({
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
        tool_input: { command: "rm -rf build" },
        cwd,
      }),
    });
    const json = await res.json();
    decision = json?.hookSpecificOutput?.permissionDecision ?? "hook-empty";
  } catch {
    decision = "hook-failed";
  }
}
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: "message", id: "l-" + stamp, parentId: null, timestamp: "t", message: assistantMessage, model: "fake/model" }) + "\\n",
);
emit({
  type: "run_end",
  result: {
    finalText: decision ?? "done",
    stopReason: "end_turn",
    turnCount: 1,
    usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    nextState: { sessionId, messages: [userMessage, assistantMessage], interrupted: false },
  },
});
process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    sessionId,
    usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1,
    finalText: decision ?? "done",
  }) + "\\n",
);
process.exit(0);
`;

const fakeBinary = NodePath.join(TMP, "fake-cmd.mjs");
NodeFS.writeFileSync(fakeBinary, FAKE_CMD, { mode: 0o755 });

// ── The real hook bridge, built once for the file ─────────────

const bridgeState: {
  scope: Scope.Closeable | null;
  bridge: HookBridge["Service"] | null;
} = { scope: null, bridge: null };

const bridge = (): Effect.Effect<HookBridge["Service"]> =>
  Effect.suspend(() =>
    bridgeState.bridge !== null
      ? Effect.succeed(bridgeState.bridge)
      : // A build failure is a test bug, not a connector answer — defect it.
        Effect.uninterruptible(
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const httpContext = yield* Layer.build(
              NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }),
            ).pipe(Scope.provide(scope));
            const bridgeContext = yield* Layer.build(
              HookBridge.layer.pipe(Layer.provide(Layer.succeedContext(httpContext))),
            ).pipe(Scope.provide(scope));
            yield* Layer.build(
              HttpRouter.serve(
                HookBridge.route.pipe(Layer.provide(Layer.succeedContext(bridgeContext))),
                { disableListenLog: true },
              ).pipe(Layer.provide(Layer.succeedContext(httpContext))),
            ).pipe(Scope.provide(scope));
            bridgeState.scope = scope;
            bridgeState.bridge = Context.get(bridgeContext, HookBridge);
            return bridgeState.bridge;
          }).pipe(Effect.orDie),
        ),
  );

afterAll(() => {
  NodeFS.rmSync(TMP, { recursive: true, force: true });
  if (previousOpenadeHome === undefined) {
    delete process.env.OPENADE_HOME;
  } else {
    process.env.OPENADE_HOME = previousOpenadeHome;
  }
  if (bridgeState.scope !== null) {
    return Effect.runPromise(Scope.close(bridgeState.scope, Exit.succeed(undefined)));
  }
  return undefined;
});

// Threads whose session is still open — a session revokes its hook
// registration on close, so "not registered and no live child pid" is the
// honest version of "the process tree is gone" for a per-turn-process harness.
const openThreads = new Set<ThreadId>();

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const services: ConnectorServices = {
  mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
  hookEndpoint: (threadId) => bridge().pipe(Effect.flatMap((b) => b.endpointFor(threadId))),
  registerHookHandler: (threadId, handler) =>
    bridge().pipe(
      Effect.flatMap((b) => b.register(threadId, handler)),
      Effect.tap(() => Effect.sync(() => openThreads.add(threadId))),
    ),
  unregisterHookHandler: (threadId) =>
    bridge().pipe(
      Effect.flatMap((b) => b.unregister(threadId)),
      Effect.tap(() => Effect.sync(() => openThreads.delete(threadId))),
    ),
  permissions: {
    decide: () => Effect.succeed("prompt" as const),
  },
  attachmentsDir: NodePath.join(TMP, "attachments"),
  logger: { log: () => Effect.void },
  // The ambient runtime clock — only `currentTimeMillis` is consulted today.
  clock: Effect.runSync(Effect.clockWith((clock) => Effect.succeed(clock))),
};

runConnectorConformance(cmdConnectorDefinition, {
  instanceId: makeConnectorInstanceId(),
  services,
  config: {
    binaryPath: fakeBinary,
    extraEnv: {
      HOME: HOME_DIR,
      OPENADE_FAKE_SESSION_ID: SESSION_ID,
      OPENADE_FAKE_PID_DIR: PID_DIR,
    },
  },
  session: {
    threadId: makeThreadId(),
    projectId: makeProjectId(),
    workspaceRoot: WORKSPACE,
    settings: {
      model: "fake/model",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  },
  turn: { text: "say done", attachments: [], mentions: [] },
  approvalTurn: { text: "please approve this", attachments: [], mentions: [] },
  isProcessGone: (threadId) =>
    Effect.sync(() => {
      if (openThreads.has(threadId)) return false;
      return NodeFS.readdirSync(PID_DIR).every((name) => !pidAlive(Number(name)));
    }),
});
