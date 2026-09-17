/**
 * The transport's done-when proof, over a real WebSocket:
 *
 * - `server.hello` answers with the boot identity.
 * - A wrong token gets a 401 on the upgrade, before any RPC runs.
 * - Dispatch + subscribe round-trips a real command through the engine.
 * - A client that drops its socket, reconnects and resubscribes with
 *   `afterSequence` receives exactly the events it missed.
 * - The 200-item thread stays under the wire budget (transfer-budget test).
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import {
  makeCommandId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeConnectorInstanceId,
  makeEventId,
} from "@OpenAde/contracts/ids";
import type { Command } from "@OpenAde/contracts/orchestration";
import { OpenAdeRpcError, STREAM_BUDGET_BYTES } from "@OpenAde/contracts/rpc";
import { Connection, makeConnection } from "@OpenAde/client-runtime/connection";
import { makeFakeConnector } from "@OpenAde/testkit/fakeConnector";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { McpGateway } from "../mcp/McpGateway";
import { CheckpointHook, CheckpointReactor } from "../orchestration/CheckpointReactor";
import { OrchestrationEngine } from "../orchestration/Engine";
import { ProviderCommandReactor } from "../orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "../orchestration/SessionManager";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { serverLayer, ServerToken } from "./server";
import {
  BrowserService,
  CmdConfig,
  ConnectorCatalog,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
} from "./services";

const TOKEN = "test-token";
const INSTANCE_ID = "01900000-0000-7000-8000-000000000000";

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/openade-transport-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

/** Real sqlite + engine + reactors + WS transport on an ephemeral port. */
const testStack = (browserLayer: Layer.Layer<BrowserService> = BrowserService.empty) =>
  Effect.gen(function* () {
    // One sqlite instance feeds persistence, the engine and the settings
    // service — built once so every consumer shares the same connection.
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const fake = yield* makeFakeConnector();
    const instance = yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engineLayer = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const selection = ConnectorSelection.fromInstance(instance);
    const managerLayer = SessionManager.layer.pipe(
      Layer.provide(Layer.mergeAll(engineLayer, selection)),
    );
    const reactors = Layer.mergeAll(ProviderCommandReactor, CheckpointReactor).pipe(
      Layer.provide(Layer.mergeAll(engineLayer, managerLayer, CheckpointHook.noop, persistence)),
    );
    const stack = Layer.mergeAll(engineLayer, managerLayer, reactors);
    const serviceLayer = Layer.mergeAll(
      Layer.succeed(ServerIdentity, { serverInstanceId: INSTANCE_ID }),
      Layer.succeed(ServerToken, { token: TOKEN }),
      ConnectorCatalog.empty,
      FileService.empty,
      GitService.empty,
      browserLayer,
      McpGateway.layer.pipe(Layer.provide(Layer.mergeAll(browserLayer, engineLayer, managerLayer))),
      CmdConfig.empty,
      SettingsStore.layer.pipe(Layer.provide(sqlite)),
    );
    const http = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" });
    const httpContext = yield* Layer.build(http);
    const stackContext = yield* Layer.build(stack);
    const app = serverLayer.pipe(
      Layer.provide(serviceLayer),
      Layer.provide(Layer.succeedContext(Context.merge(httpContext, stackContext))),
    );
    yield* Layer.build(app);
    const address = Context.get(httpContext, HttpServer.HttpServer).address;
    const port =
      typeof address === "object" && address !== null && "port" in address ? address.port : 0;
    return {
      fake,
      engine: Context.get(stackContext, OrchestrationEngine),
      url: `ws://127.0.0.1:${port}/ws`,
    };
  });

const connect = (url: string, token: string, sockets?: Array<WebSocket>) =>
  Layer.build(
    makeConnection({
      url,
      token,
      ...(sockets === undefined
        ? {}
        : {
            webSocketConstructor: (wsUrl: string) => {
              const ws = new WebSocket(wsUrl);
              sockets.push(ws);
              ws.addEventListener("close", (e) =>
                console.log("WS-CLOSE", sockets.length - 1, e.code, e.reason),
              );
              ws.addEventListener("error", (e) => console.log("WS-ERR", String(e)));
              return ws;
            },
          }),
    }),
  ).pipe(Effect.map((ctx) => Context.get(ctx, Connection)));

const projectId = makeProjectId();
const threadId = makeThreadId();

const createProject: Command = {
  commandId: makeCommandId(),
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "project.create",
  projectId,
  name: "demo",
  workspaceRoot: "/repo",
};

const createThread: Command = {
  commandId: makeCommandId(),
  createdAt: "2026-01-01T00:00:01.000Z",
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model" },
};

describe("transport", () => {
  it.live("server.hello answers with protocol version and instance id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        const hello = yield* client["server.hello"]({});
        expect(hello.protocolVersion).toBe(1);
        expect(hello.serverInstanceId).toBe(INSTANCE_ID);
      }),
    ),
  );

  it.live("connection.client resolves on every call within one connection epoch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });

        // The regression: `.client` used to install an unresolved deferred on
        // connect, so a second call in the same epoch hung until the next
        // reconnect. It must resolve immediately with the live client.
        const again = yield* connection.client.pipe(Effect.timeout("5 seconds"));
        const receipt = yield* again["orchestration.dispatch"]({ command: createThread });
        expect(receipt.status).toBe("accepted");
      }),
    ),
  );

  it.live("browser.humanInput failures reach the client as RPC errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failingBrowser = Layer.succeed(
          BrowserService,
          BrowserService.of({
            subscribe: () => Stream.never,
            humanInput: () => Effect.fail(new Error("cdp connect refused")),
            callTool: () => Effect.succeed({ kind: "error", message: "cdp connect refused" }),
            teardown: () => Effect.void,
          }),
        );
        const { url } = yield* testStack(failingBrowser);
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        const error = yield* client["browser.humanInput"]({
          threadId,
          input: { kind: "text", text: "hi" },
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenAdeRpcError);
        if (error instanceof OpenAdeRpcError) {
          expect(error.code).toBe("internal");
          // The internal detail must not leak into the wire message.
          expect(error.message).toBe("internal error");
          expect(error.message).not.toContain("cdp");
        }
      }),
    ),
  );

  it.live("a wrong token gets a 401 on the upgrade", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const httpUrl = url.replace(/^ws/, "http");
        const denied = yield* Effect.promise(() =>
          fetch(`${httpUrl}?token=wrong`).then((r) => r.status),
        );
        const missing = yield* Effect.promise(() => fetch(httpUrl).then((r) => r.status));
        expect(denied).toBe(401);
        expect(missing).toBe(401);
      }),
    ),
  );

  it.live("dispatch + subscribe round-trips a command through the engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        const receipt = yield* client["orchestration.dispatch"]({ command: createThread });
        expect(receipt.status).toBe("accepted");

        const kinds = yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.map((item) => item.kind),
          Stream.take(2),
          Stream.runCollect,
        );
        expect(kinds).toEqual(["snapshot", "synchronized"]);
      }),
    ),
  );

  it.live("a reconnected client receives exactly the missed events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, engine } = yield* testStack();
        const sockets: Array<WebSocket> = [];
        const connection = yield* connect(url, TOKEN, sockets);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });

        // Subscribe and drain the snapshot so the client holds sequence 3.
        yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.take(2),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
        );

        // Drop the socket and wait for the supervisor to observe it — until
        // the state flips to "reconnecting", `.client` can still hand out the
        // dying epoch's client (the close handshake is async).
        sockets.forEach((ws) => ws.close());
        yield* SubscriptionRef.changes(connection.state).pipe(
          Stream.filter((state) => state.status === "reconnecting"),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: "2026-01-01T00:00:02.000Z",
            type: "thread.message.queued",
            actor: "user",
            payload: {
              message: {
                queuedMessageId: makeItemId(),
                text: "missed while offline",
                attachments: [],
                mentions: [],
                queuedAt: "2026-01-01T00:00:02.000Z",
              },
            },
          },
        ]);

        // Resubscribe from the snapshot position (2) on the fresh client →
        // exactly the one missed event (sequence 3).
        const reconnected = yield* connection.client;
        const missed = yield* reconnected["threads.subscribe"]({
          threadId,
          afterSequence: 2,
        }).pipe(
          Stream.filter((item) => item.kind === "event"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        expect(missed[0]?.kind).toBe("event");
        if (missed[0]?.kind === "event") {
          expect(missed[0].event.type).toBe("thread.message.queued");
        }
      }),
    ),
  );

  it.live("a 200-item thread's stream stays under the transfer budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, engine } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });

        for (let i = 0; i < 200; i += 1) {
          yield* engine.appendThreadEvents(threadId, [
            {
              eventId: makeEventId(),
              streamKind: "thread",
              streamId: threadId,
              occurredAt: "2026-01-01T00:00:00.000Z",
              type: "thread.item.upserted",
              actor: "connector",
              payload: {
                item: {
                  itemId: makeItemId(),
                  kind: "assistant_message",
                  status: "completed",
                  text: `chunk ${i}`,
                },
              },
            },
          ]);
        }

        // The snapshot carries all 200 items; wire bytes must fit the budget.
        const frames = yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        let bytes = 0;
        for (const frame of frames) {
          bytes += new TextEncoder().encode(JSON.stringify(frame)).length;
        }
        expect(frames[0]?.kind).toBe("snapshot");
        expect(frames[1]?.kind).toBe("synchronized");
        expect(bytes).toBeLessThan(STREAM_BUDGET_BYTES);
      }),
    ),
  );
});
