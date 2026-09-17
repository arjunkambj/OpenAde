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
import { makeRegistry } from "@OpenAde/connector-sdk/registry";
import { uuidV7 } from "@OpenAde/shared/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { CheckpointHook, CheckpointReactor } from "./orchestration/CheckpointReactor";
import { OrchestrationEngine } from "./orchestration/Engine";
import { ProviderCommandReactor } from "./orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "./orchestration/SessionManager";
import { makeSessionSupervisor } from "./orchestration/SessionSupervisor";
import { EventStore } from "./persistence/EventStore";
import { ReadModelStore } from "./persistence/ReadModels";
import { defaultLayer as sqliteLayer } from "./persistence/Sqlite";
import { writeHandshake } from "./rpc/bootstrap";
import { serverLayer, ServerToken } from "./rpc/server";
import {
  BrowserService,
  CmdConfig,
  ConnectorCatalog,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
} from "./rpc/services";

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
  const registry = yield* makeRegistry([]);
  const selection = ConnectorSelection.fromRegistry(registry);
  const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
  const reactors = Layer.mergeAll(
    ProviderCommandReactor,
    CheckpointReactor,
    makeSessionSupervisor({}),
  ).pipe(Layer.provide(Layer.mergeAll(engine, manager, CheckpointHook.noop)));

  const services = Layer.mergeAll(
    Layer.succeed(ServerIdentity, { serverInstanceId }),
    Layer.succeed(ServerToken, { token }),
    ConnectorCatalog.empty,
    FileService.empty,
    GitService.empty,
    BrowserService.empty,
    CmdConfig.empty,
    SettingsStore.layer.pipe(Layer.provide(sqlite)),
  );

  const http = NodeHttpServer.layer(createServer, { port: PORT, host: "127.0.0.1" });
  // One build of the http layer: the same server object serves the routes and
  // reports the bound port for the handshake.
  const httpContext = yield* Layer.build(http);
  const app = serverLayer.pipe(
    Layer.provide(services),
    Layer.provideMerge(Layer.mergeAll(engine, manager, reactors)),
    Layer.provide(Layer.succeedContext(httpContext)),
  );

  yield* Layer.build(app);
  const server = Context.get(httpContext, HttpServer.HttpServer);
  const address = server.address;
  const port =
    typeof address === "object" && address !== null && "port" in address ? address.port : PORT;

  yield* writeHandshake(
    { url: `ws://127.0.0.1:${port}/ws`, token, serverInstanceId },
    { dev: DEV },
  );

  yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(main));
