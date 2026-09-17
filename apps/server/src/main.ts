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
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { eraseConnectorDefinition } from "@OpenAde/connector-sdk/definition";
import { makeRegistry } from "@OpenAde/connector-sdk/registry";
import { makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorInstanceConfig } from "@OpenAde/contracts/settings";
import { uuidV7 } from "@OpenAde/shared/ids";
import { configPath } from "@OpenAde/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { HookBridge } from "./hooks/HookBridge";
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
import { BrowserService, ServerIdentity, SettingsStore } from "./rpc/services";
import { layer as cmdConfigLayer } from "./settings/CmdConfig";
import { ConnectorHost } from "./settings/ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./settings/ConnectorManager";

const DEV = process.env.OPENADE_DEV === "1" || process.argv.includes("--dev");
const PORT = Number.parseInt(process.env.OPENADE_PORT ?? "0", 10);

const main = Effect.gen(function* () {
  const token = uuidV7();
  const serverInstanceId = uuidV7();

  const sqlite = sqliteLayer();
  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const registry = yield* makeRegistry([eraseConnectorDefinition(cmdConnectorDefinition)]);
  const selection = ConnectorSelection.fromRegistry(registry);
  const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
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

  const services = Layer.mergeAll(
    Layer.succeed(ServerIdentity, { serverInstanceId }),
    Layer.succeed(ServerToken, { token }),
    sharedSettings,
    fileServiceLayer.pipe(Layer.provide(persistence)),
    gitServiceLayer.pipe(Layer.provide(persistence)),
    BrowserService.empty,
    cmdConfigLayer().pipe(Layer.provide(persistence)),
    // SettingsStore is not listed here: `sharedSettings` already merges the one
    // instance the manager watches and the RPC handlers mutate.
    PermissionService.layer.pipe(Layer.provide(sqlite)),
  );

  const http = NodeHttpServer.layer(createServer, { port: PORT, host: "127.0.0.1" });
  // One build of the http layer: the same server object serves the routes and
  // reports the bound port for the handshake.
  const httpContext = yield* Layer.build(http);
  const servicesContext = yield* Layer.build(services);
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

  // ── Connectors: the services bag + one instance per settings entry ──
  //
  // The hook endpoint is this same HTTP server's /hooks/pretooluse route; the
  // bearer is per thread, minted by the bridge. There is no MCP endpoint yet
  // (W6) — an empty url tells the connector to skip .mcp.json.
  const bridge = Context.get(appContext, HookBridge);
  const engineService = Context.get(appContext, OrchestrationEngine);
  const permissionService = Context.get(servicesContext, PermissionService);
  const settingsStore = Context.get(servicesContext, SettingsStore);
  const clock = yield* Effect.clockWith(Effect.succeed);

  const connectorServices: ConnectorServices = {
    mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
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
    attachmentsDir: configPath(["attachments"]),
    logger: {
      log: (level, message, data) =>
        level === "error"
          ? Effect.logError(message, data)
          : level === "warn"
            ? Effect.logWarning(message, data)
            : level === "debug"
              ? Effect.logDebug(message, data)
              : Effect.logInfo(message, data),
    },
    clock,
  };

  // A fresh install has no connectors configured: open one "cmd" instance and
  // persist it, so threads keep routing to the same instance id across restarts.
  const settings = yield* settingsStore.get;
  let entries = settings.connectors.filter((entry) => entry.enabled);
  if (settings.connectors.length === 0) {
    const entry: ConnectorInstanceConfig = {
      connectorInstanceId: makeConnectorInstanceId(),
      kind: "cmd",
      displayName: "Command Code",
      enabled: true,
      config: {},
    };
    yield* settingsStore
      .update({ connectors: [entry] })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not persist the default connector instance", error),
        ),
      );
    entries = [entry];
  }
  for (const entry of entries) {
    yield* registry
      .open({
        instanceId: entry.connectorInstanceId,
        kind: entry.kind,
        config: entry.config ?? {},
        services: connectorServices,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `connector instance ${entry.connectorInstanceId} failed to open`,
            error,
          ),
        ),
      );
  }

  yield* writeHandshake(
    { url: `ws://127.0.0.1:${port}/ws`, token, serverInstanceId },
    { dev: DEV },
  );

  yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(main));
