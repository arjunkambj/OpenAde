/**
 * The OpenAde server entrypoint.
 *
 * Composes the W1 engine stack with the W3 transport: SQLite persistence, the
 * orchestration engine, session drivers, reactors and supervisor, the RPC
 * handler layer, and the HTTP+WebSocket server. On boot it emits
 * `{ url, token, serverInstanceId }` on fd 3 (Electron) or one stdout line
 * (terminal/dev), and in dev also writes `~/.openade/dev/connection.json`.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { cmdConnectorDefinition } from "@OpenAde/connector-cmd/definition";
import { eraseConnectorDefinition } from "@OpenAde/connector-sdk/definition";
import { makeRegistry } from "@OpenAde/connector-sdk/registry";
import { uuidV7 } from "@OpenAde/shared/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { AttachmentStore } from "./attachments/AttachmentStore";
import { AgentBrowser } from "./browser/agentBrowser";
import { layer as browserServiceLayer } from "./browser/BrowserService";
import { HookBridge } from "./hooks/HookBridge";
import { McpGateway } from "./mcp/McpGateway";
import { SessionServices } from "./mcp/sessionServices";
import { CheckpointReactor } from "./orchestration/CheckpointReactor";
import { OrchestrationEngine } from "./orchestration/Engine";
import { ProviderCommandReactor } from "./orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "./orchestration/SessionManager";
import { makeSessionSupervisor } from "./orchestration/SessionSupervisor";
import { EventStore } from "./persistence/EventStore";
import { runMigrations } from "./persistence/Migrations";
import { ReadModelStore } from "./persistence/ReadModels";
import { defaultLayer as sqliteLayer } from "./persistence/Sqlite";
import { PermissionService } from "./permissions/PermissionService";
import { layer as gitCheckpointHookLayer } from "./git/CheckpointHook";
import { layer as fileServiceLayer } from "./git/Files";
import { layer as gitServiceLayer } from "./git/Git";
import { writeHandshake } from "./rpc/bootstrap";
import { serverLayer, ServerToken } from "./rpc/server";
import { ServerIdentity, SettingsStore } from "./rpc/services";
import { layer as cmdConfigLayer } from "./settings/CmdConfig";
import { ConnectorHost } from "./settings/ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./settings/ConnectorManager";

const DEV = process.env.OPENADE_DEV === "1" || process.argv.includes("--dev");
const PORT = Number.parseInt(process.env.OPENADE_PORT ?? "0", 10);

const main = Effect.gen(function* () {
  const token = uuidV7();
  const serverInstanceId = uuidV7();

  // One sqlite client for the whole process, migrated before anything reads
  // it. `services` is built before the engine, and the connector manager
  // reconciles against the settings table as it is constructed — the engine's
  // own `runMigrations` would arrive too late for that read.
  const sqliteContext = yield* Layer.build(sqliteLayer());
  const sqlite = Layer.succeedContext(sqliteContext);
  yield* runMigrations.pipe(Effect.provide(sqlite));

  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const registry = yield* makeRegistry([eraseConnectorDefinition(cmdConnectorDefinition)]);
  const selection = ConnectorSelection.fromRegistry(registry);
  const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
  const attachments = AttachmentStore.layer;
  const reactors = Layer.mergeAll(
    ProviderCommandReactor,
    CheckpointReactor,
    makeSessionSupervisor({}),
  ).pipe(Layer.provide(Layer.mergeAll(engine, manager, gitCheckpointHookLayer, persistence)));

  // The settings store and the connector manager share one graph: the manager
  // watches the same store instance the RPC handlers mutate, and the catalog
  // answers from the manager's probes. Built once inside `services`.
  const sharedSettings = ConnectorManager.catalogLayer.pipe(
    Layer.provideMerge(
      ConnectorManager.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SettingsStore.layer,
            ConnectorHost.layer,
            Layer.succeed(ConnectorRegistryService, registry),
          ),
        ),
      ),
    ),
    Layer.provide(sqlite),
  );

  // W6: browser sessions + the MCP gateway + the connector services bundle.
  // `browser` is shared by the RPC handlers and the gateway (the layer graph
  // memoizes it, so both see the one session registry); HttpServer flows in
  // from the outermost provide for the attach-marker and endpoint URLs.
  const permissions = PermissionService.layer.pipe(Layer.provide(sqlite));
  const browser = browserServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(engine, permissions, AgentBrowser.layer)),
  );
  const mcp = McpGateway.layer.pipe(Layer.provide(Layer.mergeAll(browser, engine, manager)));
  const sessionServices = SessionServices.layer.pipe(
    Layer.provide(Layer.mergeAll(mcp, permissions)),
  );

  const services = Layer.mergeAll(
    Layer.succeed(ServerIdentity, { serverInstanceId }),
    Layer.succeed(ServerToken, { token }),
    sharedSettings,
    fileServiceLayer.pipe(Layer.provide(persistence)),
    gitServiceLayer.pipe(Layer.provide(persistence)),
    attachments,
    browser,
    mcp,
    sessionServices,
    cmdConfigLayer().pipe(Layer.provide(persistence)),
    // SettingsStore is not listed here: `sharedSettings` already merges the one
    // instance the manager watches and the RPC handlers mutate.
    permissions,
  );

  const http = NodeHttpServer.layer(createServer, { port: PORT, host: "127.0.0.1" });
  // One build of the http layer: the same server object serves the routes and
  // reports the bound port for the handshake.
  const httpContext = yield* Layer.build(http);
  // The session-services bundle reads the bound address to build its loopback
  // MCP and hook URLs, so `services` is built against the http context.
  const servicesContext = yield* Layer.build(
    services.pipe(Layer.provide(Layer.succeedContext(httpContext))),
  );
  const app = serverLayer.pipe(
    Layer.provide(Layer.succeedContext(servicesContext)),
    Layer.provideMerge(Layer.mergeAll(engine, manager, reactors)),
    Layer.provide(Layer.succeedContext(httpContext)),
  );

  const appContext = yield* Layer.build(app);
  const server = Context.get(httpContext, HttpServer.HttpServer);
  const address = server.address;
  const port =
    typeof address === "object" && address !== null && "port" in address ? address.port : PORT;

  // ── Connectors: the endpoints only the running app can supply ──
  //
  // `ConnectorManager` owns the connector lifecycle — seeding a fresh install,
  // probing, and opening one instance per enabled settings entry — and it does
  // that while the layer graph is built, before the pieces below exist. So the
  // services object it already handed those instances is `ConnectorHost`'s
  // façade, and this fills it in: the gateway's per-thread MCP endpoint, the
  // hook bridge's endpoint and handler registry, and a permission ladder that
  // resolves the thread's project before it decides. It runs before the
  // handshake, so no client can start a session against a half-wired host.
  const bridge = Context.get(appContext, HookBridge);
  const engineService = Context.get(appContext, OrchestrationEngine);
  const permissionService = Context.get(servicesContext, PermissionService);
  const sessionBundle = Context.get(servicesContext, SessionServices);
  const connectorHost = Context.get(servicesContext, ConnectorHost);

  yield* connectorHost.install({
    mcpEndpoint: sessionBundle.mcpEndpoint,
    hookEndpoint: (threadId) => bridge.endpointFor(threadId),
    registerHookHandler: (threadId, handler) => bridge.register(threadId, handler),
    unregisterHookHandler: (threadId) => bridge.unregister(threadId),
    permissions: {
      decide: (input) =>
        engineService.threadDoc(input.threadId).pipe(
          Effect.flatMap((doc) =>
            permissionService.decide({
              request: input.request,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              threadId: input.threadId,
              ...(doc === null ? {} : { projectId: doc.projectId }),
            }),
          ),
          // A permissions failure must never read as allow.
          Effect.catch((error) =>
            Effect.logWarning("permission decide failed; prompting", error).pipe(
              Effect.as("prompt" as const),
            ),
          ),
        ),
    },
  });

  // The manager's first pass registers every enabled instance before it probes,
  // and this waits for it: `ConnectorSelection` reads the live registry, so a
  // client admitted before that pass lands would fail its first turn with
  // `NoConnector`. Probes keep running behind the handshake.
  yield* Context.get(servicesContext, ConnectorManager).ready;

  yield* writeHandshake(
    { url: `ws://127.0.0.1:${port}/ws`, token, serverInstanceId },
    { dev: DEV },
  );

  yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(main));
