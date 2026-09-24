/**
 * `runConnectorConformance` against the real `cmdConnectorDefinition`.
 *
 * The binary is testkit's replayer, so every frame, transcript line and hook
 * payload in this file came off the real `cmd` 1.55.1
 * (`packages/testkit/fixtures/cmd/`). Everything between the recording and the
 * assertions is production code: the real argv, a transcript appearing on disk
 * in the directory the harness really uses, the installed `cmd-hook.mjs` run
 * through the system shell, POSTing to a real `HookBridge` on a real bound
 * port, a pid file so `isProcessGone` inspects real children. The whole round
 * trip, minus the model — and the model's half is the recording.
 *
 * The suite runs on `text/`, a turn with no tool calls, because its plain tests
 * send turns nobody answers approvals for. The approval half is the test below
 * it, which drives `shell-yolo/` — a real `shell_command` gated by a real hook —
 * and asserts the same invariant `approvalTurn` does: every request opened is
 * resolved, and the turn finishes.
 *
 * Nothing touches the real `~/.commandcode` or `~/.poseidon`: `POSEIDON_HOME` is
 * redirected for the duration of this file, and `HOME` per session.
 */

import { createServer } from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { runConnectorConformance } from "@poseidon/connector-sdk/conformance";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import { cmdConnectorDefinition } from "@poseidon/connector-cmd/definition";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { loadRecording, replayConfig } from "@poseidon/testkit/replayCmdProcess";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";
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
NodeFS.mkdirSync(HOME_DIR, { recursive: true });
NodeFS.mkdirSync(WORKSPACE, { recursive: true });
NodeFS.mkdirSync(PID_DIR, { recursive: true });

const previousPoseidonHome = process.env.POSEIDON_HOME;
process.env.POSEIDON_HOME = NodePath.join(TMP, "poseidon");

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
  if (previousPoseidonHome === undefined) {
    delete process.env.POSEIDON_HOME;
  } else {
    process.env.POSEIDON_HOME = previousPoseidonHome;
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

/** The recorded model, so the settings name what actually answered. */
const MODEL = loadRecording("text").model;

runConnectorConformance(cmdConnectorDefinition, {
  instanceId: makeConnectorInstanceId(),
  services,
  // A recorded turn with no tool calls: the suite's plain tests send turns and
  // wait for them, and nobody is there to answer an approval.
  config: replayConfig("text", { home: HOME_DIR, pidDir: PID_DIR, turn: 0 }),
  session: {
    threadId: makeThreadId(),
    projectId: makeProjectId(),
    workspaceRoot: WORKSPACE,
    settings: {
      model: MODEL,
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  },
  // The replay ignores the prompt — the recording decides what the turn does.
  turn: { text: "Reply with exactly: ok", attachments: [], mentions: [] },
  isProcessGone: (threadId) =>
    Effect.sync(() => {
      if (openThreads.has(threadId)) return false;
      return NodeFS.readdirSync(PID_DIR).every((name) => !pidAlive(Number(name)));
    }),
});

// ── the approval round trip, end to end ───────────────────────

/**
 * What `approvalTurn` checks, on a recording that really needs an approval:
 * `shell-yolo/` is a `shell_command` the real CLI gated through a real
 * PreToolUse hook. Here that hook is the connector's own `cmd-hook.mjs`, run
 * through the system shell by the replayer, POSTing to a real `HookBridge`,
 * answered by a real permission decision the test makes — and only then does
 * the recorded call run.
 */
describe("an approval through the whole bridge", () => {
  it.live("opens a request, waits for the answer, and finishes the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = NodePath.join(TMP, "approval-home");
        const workspace = NodePath.join(TMP, "approval-workspace");
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(home, { recursive: true });
          NodeFS.mkdirSync(workspace, { recursive: true });
        });
        const threadId = makeThreadId();
        const replay = replayConfig("shell-yolo", { home, turn: 0 });
        const instance = yield* cmdConnectorDefinition.createInstance({
          instanceId: makeConnectorInstanceId(),
          config: replay,
          services,
        });
        const handle = yield* instance.startSession({
          threadId,
          projectId: makeProjectId(),
          workspaceRoot: workspace,
          settings: { model: MODEL, runtimeMode: "approval-required", interactionMode: "default" },
        });
        const collector = yield* makeStreamCollector(handle.events);

        yield* handle.send({
          text: "Run the shell command `cat note.txt`.",
          attachments: [],
          mentions: [],
        });

        const opened = yield* collector.awaitItem((event) => event.type === "request.opened");
        if (opened.type !== "request.opened") {
          throw new Error("collector returned the wrong event");
        }
        const request = opened.payload.request;
        // The hook payload the real CLI sent, carried all the way through.
        expect(request.toolName).toBe("shell_command");
        expect((request.input as { command?: string }).command).toBe("cat note.txt");

        yield* handle.respondToRequest(request.requestId, "allow-once");
        yield* collector.awaitItem(
          (event) =>
            event.type === "request.resolved" && event.payload.requestId === request.requestId,
        );
        yield* collector.awaitItem((event) => event.type === "turn.completed");

        const events = yield* collector.collected;
        const openedIds = events.flatMap((event) =>
          event.type === "request.opened" ? [event.payload.request.requestId] : [],
        );
        const resolvedIds = new Set(
          events.flatMap((event) =>
            event.type === "request.resolved" ? [event.payload.requestId] : [],
          ),
        );
        expect(openedIds.filter((id) => !resolvedIds.has(id))).toEqual([]);

        // And the call the approval unblocked really ran.
        const shell = events.flatMap((event) =>
          event.type === "item.completed" && event.payload.item.kind === "command_execution"
            ? [event.payload.item]
            : [],
        );
        expect(shell.at(-1)?.command?.output).toBe("hello\n");

        yield* handle.close();
      }),
    ),
  );
});
