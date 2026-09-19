/**
 * The conformance suite against the REAL Command Code CLI.
 *
 * Every other test in the repo replays a recording. This one spends the
 * operator's plan, so it is opt-in and never runs in CI:
 *
 *     OPENADE_LIVE_CMD=1 pnpm vitest run apps/server/src/hooks/cmdLiveConformance.test.ts
 *
 * What it proves that a replay cannot: that the argv the connector builds is
 * argv the current `cmd` accepts, that the session id still arrives on stderr,
 * that the transcript still lands where the locator looks for it, and that a
 * real model's frames still map without falling through to `event.unmapped`.
 * When the CLI changes under us, this is what says so.
 *
 * Kept deliberately cheap: short prompts, `Reply with exactly: ok`, and the
 * approval turn reads one small file. The suite spends about six turns.
 *
 * `HOME` is the operator's own, because that is where the CLI's credentials
 * live — the only thing written there is the session record the CLI writes for
 * any run. `OPENADE_HOME` is redirected, so nothing of ours is touched.
 */

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { runConnectorConformance } from "@OpenAde/connector-sdk/conformance";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
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

const LIVE = process.env.OPENADE_LIVE_CMD === "1";

/**
 * The only models a live turn may run on. `cmd --list-models` offers about
 * seventy and most of them cost real money; these three are the ones the
 * operator authorised. The default is the account's own — cheap, and good at
 * tool use, which the approval test needs.
 */
const AUTHORISED_MODELS = [
  "meta/muse-spark-1.3-contributor",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-sante:free",
] as const;

const MODEL = process.env.OPENADE_LIVE_CMD_MODEL ?? AUTHORISED_MODELS[0];

if (!LIVE) {
  describe("the real Command Code CLI", () => {
    it.skip("is only driven when OPENADE_LIVE_CMD=1 — it spends the operator's plan", () => {
      // Intentionally empty.
    });
  });
} else {
  // A live turn is a model round trip: seconds, not the 5s vitest allows by
  // default. The shared conformance suite sets no timeout of its own, so the
  // whole file gets one here rather than depending on a command-line flag.
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

  const TMP = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-live-"));
  const WORKSPACE = NodePath.join(TMP, "workspace");
  const PID_DIR = NodePath.join(TMP, "pids");
  NodeFS.mkdirSync(WORKSPACE, { recursive: true });
  NodeFS.mkdirSync(PID_DIR, { recursive: true });
  // A throwaway git repo, so the harness sees an ordinary workspace.
  NodeFS.writeFileSync(NodePath.join(WORKSPACE, "note.txt"), "hello\n", "utf8");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "live@example.invalid"],
    ["config", "user.name", "live"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed", "--allow-empty"],
  ]) {
    execFileSync("git", args, { cwd: WORKSPACE, stdio: "ignore" });
  }

  const previousOpenadeHome = process.env.OPENADE_HOME;
  process.env.OPENADE_HOME = NodePath.join(TMP, "openade");

  const bridgeState: { scope: Scope.Closeable | null; bridge: HookBridge["Service"] | null } = {
    scope: null,
    bridge: null,
  };

  const bridge = (): Effect.Effect<HookBridge["Service"]> =>
    Effect.suspend(() =>
      bridgeState.bridge !== null
        ? Effect.succeed(bridgeState.bridge)
        : Effect.uninterruptible(
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

  const openThreads = new Set<ThreadId>();

  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** `decide` is a parameter because the plain turns must never park on a prompt. */
  const servicesWith = (decide: () => Effect.Effect<"allow" | "prompt">): ConnectorServices => ({
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
    permissions: { decide },
    attachmentsDir: NodePath.join(TMP, "attachments"),
    logger: {
      log: (level, message) =>
        Effect.sync(() => {
          if (process.env.OPENADE_LIVE_CMD_DEBUG === "1") {
            process.stderr.write(`[${level}] ${message}\n`);
          }
        }),
    },
    clock: Effect.runSync(Effect.clockWith((clock) => Effect.succeed(clock))),
  });

  if (!(AUTHORISED_MODELS as ReadonlyArray<string>).includes(MODEL)) {
    throw new Error(
      `${MODEL} is not one of the models authorised for live runs: ${AUTHORISED_MODELS.join(", ")}`,
    );
  }

  const settings = {
    model: MODEL,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };

  runConnectorConformance(cmdConnectorDefinition, {
    instanceId: makeConnectorInstanceId(),
    // Everything allowed: the suite's plain turns send and wait, and there is
    // nobody to answer an approval for them.
    services: servicesWith(() => Effect.succeed("allow" as const)),
    config: {},
    session: {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: WORKSPACE,
      settings,
    },
    turn: { text: "Reply with exactly: ok", attachments: [], mentions: [] },
    isProcessGone: (threadId) =>
      Effect.sync(() => {
        if (openThreads.has(threadId)) return false;
        return NodeFS.readdirSync(PID_DIR).every((name) => !pidAlive(Number(name)));
      }),
  });

  describe("a live approval through the whole bridge", () => {
    it.live("opens a request for a real tool call, waits for the answer, and finishes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = makeThreadId();
          const instance = yield* cmdConnectorDefinition.createInstance({
            instanceId: makeConnectorInstanceId(),
            config: {},
            services: servicesWith(() => Effect.succeed("prompt" as const)),
          });
          const handle = yield* instance.startSession({
            threadId,
            projectId: makeProjectId(),
            workspaceRoot: WORKSPACE,
            settings,
          });
          const collector = yield* makeStreamCollector(handle.events);

          yield* handle.send({
            text: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
            attachments: [],
            mentions: [],
          });

          // Either outcome settles the wait, so a turn that never asks
          // fails with what did arrive instead of timing the suite out.
          const opened = yield* collector.awaitItem(
            (event) => event.type === "request.opened" || event.type === "turn.completed",
          );
          if (opened.type !== "request.opened") {
            const seen = (yield* collector.collected).map((event) => event.type);
            throw new Error(
              `the turn finished without asking for approval; saw ${seen.join(", ")}`,
            );
          }
          const request = opened.payload.request;
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
          expect(openedIds.length).toBeGreaterThan(0);
          expect(openedIds.filter((id) => !resolvedIds.has(id))).toEqual([]);

          yield* handle.close();
        }),
      ),
    );
  });

  /**
   * The claim the whole approval gate rests on, made against the real CLI.
   *
   * Every turn the connector spawns carries `--yolo`, which turns off the CLI's
   * own refusal of writes and shell calls, so our PreToolUse answer is the only
   * thing left between a model and the machine. A recording proves the deny is
   * honoured (`fixtures/cmd/shell-deny-yolo/`); this proves the live wiring
   * that carries it — bridge, ticket file, hook script — still delivers it.
   */
  describe("a live approval answered deny", () => {
    it.live("stops the call, fails the row, and leaves the side effect undone", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = makeThreadId();
          const target = NodePath.join(WORKSPACE, "denied.txt");
          NodeFS.rmSync(target, { force: true });
          const instance = yield* cmdConnectorDefinition.createInstance({
            instanceId: makeConnectorInstanceId(),
            config: {},
            services: servicesWith(() => Effect.succeed("prompt" as const)),
          });
          const handle = yield* instance.startSession({
            threadId,
            projectId: makeProjectId(),
            workspaceRoot: WORKSPACE,
            settings,
          });
          const collector = yield* makeStreamCollector(handle.events);

          yield* handle.send({
            text: "Run the shell command `cp note.txt denied.txt` and tell me what happened. Use the shell tool.",
            attachments: [],
            mentions: [],
          });

          const opened = yield* collector.awaitItem(
            (event) => event.type === "request.opened" || event.type === "turn.completed",
          );
          if (opened.type !== "request.opened") {
            const seen = (yield* collector.collected).map((event) => event.type);
            throw new Error(
              `the turn finished without asking for approval; saw ${seen.join(", ")}`,
            );
          }
          const request = opened.payload.request;
          yield* handle.respondToRequest(request.requestId, "deny");
          yield* collector.awaitItem(
            (event) =>
              event.type === "request.resolved" && event.payload.requestId === request.requestId,
          );
          yield* collector.awaitItem((event) => event.type === "turn.completed");

          const events = yield* collector.collected;
          const shell = events.flatMap((event) =>
            (event.type === "item.completed" || event.type === "item.updated") &&
            event.payload.item.kind === "command_execution"
              ? [event.payload.item]
              : [],
          );
          expect(shell.length).toBeGreaterThan(0);
          expect(shell.at(-1)?.status).toBe("failed");
          // The point of the whole gate: the command did not run.
          expect(NodeFS.existsSync(target)).toBe(false);

          yield* handle.close();
        }),
      ),
    );
  });

  describe("a live turn's frames", () => {
    it.live("all map — nothing falls through to event.unmapped", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = makeThreadId();
          const instance = yield* cmdConnectorDefinition.createInstance({
            instanceId: makeConnectorInstanceId(),
            config: {},
            services: servicesWith(() => Effect.succeed("allow" as const)),
          });
          const handle = yield* instance.startSession({
            threadId,
            projectId: makeProjectId(),
            workspaceRoot: WORKSPACE,
            settings,
          });
          const collector = yield* makeStreamCollector(handle.events);

          yield* handle.send({ text: "Reply with exactly: ok", attachments: [], mentions: [] });
          yield* collector.awaitItem((event) => event.type === "turn.completed");
          const events = yield* collector.collected;

          // The assertion this whole file exists for: a CLI that grew a frame
          // type we do not read fails here.
          const unmapped = events.flatMap((event) =>
            event.type === "event.unmapped" ? [JSON.stringify(event.raw).slice(0, 300)] : [],
          );
          expect(unmapped).toEqual([]);

          // And the run really happened: a session, a turn, an answer.
          expect(events.some((event) => event.type === "session.started")).toBe(true);
          const said = events.flatMap((event) =>
            event.type === "item.completed" && event.payload.item.kind === "assistant_message"
              ? [event.payload.item.text ?? ""]
              : [],
          );
          expect(said.join(" ").toLowerCase()).toContain("ok");

          yield* handle.close();
        }),
      ),
    );
  });
}
