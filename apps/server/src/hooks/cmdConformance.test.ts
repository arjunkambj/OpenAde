/**
 * `runConnectorConformance` against the real `cmdConnectorDefinition`.
 *
 * Command Code itself is unusable here — the account has no credits
 * (docs/decisions/w2-cmd-frames.md) — so the binary is testkit's standalone
 * `fake-cmd.mjs`, the same executable a human can point a connector instance at
 * to run the desktop app without an account. It speaks the harness's NDJSON
 * protocol for real: frames on stdout, a transcript appended under a temp
 * `HOME`, a pid file so the suite's `isProcessGone` check inspects real
 * children, and — for the approval turn — the installed `cmd-hook.mjs`, run
 * through the system shell, POSTing to a real `HookBridge` on a real bound
 * port. That is the whole production round trip, minus the model.
 *
 * Nothing touches the real `~/.commandcode` or `~/.openade`: `OPENADE_HOME` is
 * redirected for the duration of this file.
 */

import { createServer } from "node:http";
import * as NodeURL from "node:url";
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

// testkit's standalone fake, resolved from the workspace rather than copied.
const fakeBinary = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../../../packages/testkit/bin/fake-cmd.mjs",
);

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
  // The fake picks its scenario from the prompt: plain text for the ordinary
  // turn, a hook-gated shell_command for the approval one.
  turn: { text: "say done", attachments: [], mentions: [] },
  approvalTurn: { text: "please run a shell command", attachments: [], mentions: [] },
  isProcessGone: (threadId) =>
    Effect.sync(() => {
      if (openThreads.has(threadId)) return false;
      return NodeFS.readdirSync(PID_DIR).every((name) => !pidAlive(Number(name)));
    }),
});
