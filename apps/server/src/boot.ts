/**
 * The server's composition root.
 *
 * Everything the running app is made of is assembled here — SQLite persistence,
 * the orchestration engine, session drivers, reactors and supervisor, the
 * connector registry and its manager, the browser + MCP gateway, the RPC
 * handlers and the HTTP+WebSocket server — so that `main.ts` is only argument
 * parsing and a runtime call, and a test can build the very same graph.
 *
 * `boot` is scoped: closing the scope it was run in shuts the server, the
 * database and every open connector instance down. It returns once the
 * handshake has been emitted, which is also the moment the first client may
 * connect.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { cmdConnectorDefinition } from "@OpenAde/connector-cmd/definition";
import { eraseConnectorDefinition } from "@OpenAde/connector-sdk/definition";
import { makeRegistry } from "@OpenAde/connector-sdk/registry";
import { OPENADE_HOME_ENV } from "@OpenAde/shared/paths";
import { uuidV7 } from "@OpenAde/shared/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { AttachmentReactor } from "./attachments/AttachmentReactor";
import { AttachmentStore } from "./attachments/AttachmentStore";
import { AgentBrowser } from "./browser/agentBrowser";
import { layer as browserServiceLayer } from "./browser/BrowserService";
import { HookBridge } from "./hooks/HookBridge";
import { McpGateway } from "./mcp/McpGateway";
import { CheckpointReactor } from "./orchestration/CheckpointReactor";
import { OrchestrationEngine } from "./orchestration/Engine";
import { ProviderCommandReactor } from "./orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "./orchestration/SessionManager";
import { makeSessionSupervisor } from "./orchestration/SessionSupervisor";
import { EventStore } from "./persistence/EventStore";
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

/** @public The composition root's options; `main.ts` fills them from argv. */
export interface BootOptions {
  /**
   * Where the server keeps its state. This is the process-wide `OPENADE_HOME`:
   * the database, the attachments directory, the generated hook script and the
   * dev connection file all hang off it, and spawned connector processes
   * inherit it, so `boot` sets the variable rather than threading a second
   * notion of "home" through the tree. Omitted, whatever the environment
   * already says wins (`~/.openade` by default).
   */
  readonly home?: string;
  /** Dev mode also writes `<home>/dev/connection.json` for the Vite plugin. */
  readonly dev: boolean;
  /** `0` — the default — asks the OS for a free port. */
  readonly port?: number;
}

/** @public What a booted server tells a client (or the desktop shell) about itself. */
export interface BootedServer {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

/**
 * Builds and starts the whole server in the calling scope.
 *
 * @public Imported by `main.ts` and by end-to-end tests that drive a real
 * server; nothing else should compose these layers itself.
 */
export const boot = (options: BootOptions) =>
  Effect.gen(function* () {
    if (options.home !== undefined) {
      // Before anything reads a path: `configDir` and everything built on it
      // resolve this at call time, and connector children inherit it.
      yield* Effect.sync(() => {
        process.env[OPENADE_HOME_ENV] = options.home;
      });
    }
    const port = options.port ?? 0;
    const token = uuidV7();
    const serverInstanceId = uuidV7();

    // One sqlite client for the whole process. Every layer that reads a table
    // provides `Migrations.layer`, so the schema exists before the first read —
    // including the connector manager's, which reconciles against the settings
    // table as it is constructed.
    const sqliteContext = yield* Layer.build(sqliteLayer());
    const sqlite = Layer.succeedContext(sqliteContext);

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
      AttachmentReactor,
      makeSessionSupervisor({}),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(engine, manager, gitCheckpointHookLayer, persistence, attachments),
      ),
    );

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

    // W6: browser sessions + the MCP gateway. `browser` is shared by the RPC
    // handlers and the gateway (the layer graph memoizes it, so both see the
    // one session registry); HttpServer flows in from the outermost provide for
    // the attach-marker and endpoint URLs.
    const permissions = PermissionService.layer.pipe(Layer.provide(sqlite));
    const browser = browserServiceLayer.pipe(
      Layer.provide(Layer.mergeAll(engine, permissions, AgentBrowser.layer)),
    );
    const mcp = McpGateway.layer.pipe(Layer.provide(Layer.mergeAll(browser, engine, manager)));

    const services = Layer.mergeAll(
      Layer.succeed(ServerIdentity, { serverInstanceId }),
      Layer.succeed(ServerToken, { token }),
      sharedSettings,
      fileServiceLayer.pipe(Layer.provide(persistence)),
      gitServiceLayer.pipe(Layer.provide(persistence)),
      attachments,
      browser,
      mcp,
      cmdConfigLayer().pipe(Layer.provide(persistence)),
      // SettingsStore is not listed here: `sharedSettings` already merges the one
      // instance the manager watches and the RPC handlers mutate.
      permissions,
    );

    const http = NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" });
    // One build of the http layer: the same server object serves the routes and
    // reports the bound port for the handshake.
    const httpContext = yield* Layer.build(http);
    // The MCP gateway reads the bound address to build its loopback endpoint
    // URLs, so `services` is built against the http context.
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
    const boundPort =
      typeof address === "object" && address !== null && "port" in address ? address.port : port;

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
    const gateway = Context.get(servicesContext, McpGateway);
    const connectorHost = Context.get(servicesContext, ConnectorHost);

    yield* connectorHost.install({
      mcpEndpoint: gateway.endpoint,
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

    const handshake: BootedServer = {
      url: `ws://127.0.0.1:${boundPort}/ws`,
      token,
      serverInstanceId,
    };
    yield* writeHandshake(handshake, { dev: options.dev });
    return handshake;
  });
