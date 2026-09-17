/**
 * Wires `OpenAdeRpcGroup` to services. Orchestration reads and writes go to the
 * W1 engine; the surfaces other workstreams own resolve to their Tag service so
 * they can be swapped without touching this file.
 */

import { OpenAdeRpcError, OpenAdeRpcGroup, PROTOCOL_VERSION } from "@OpenAde/contracts/rpc";
import type { Command } from "@OpenAde/contracts/orchestration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ConcurrencyConflict } from "../persistence/EventStore";
import { OrchestrationEngine } from "../orchestration/Engine";
import {
  BrowserService,
  CmdConfig,
  ConnectorCatalog,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
} from "./services";

const toRpcError = (error: unknown): OpenAdeRpcError =>
  error instanceof OpenAdeRpcError
    ? error
    : error instanceof ConcurrencyConflict
      ? new OpenAdeRpcError({
          code: "conflict",
          message: `stale stream version for ${error.streamId}: ${error.message}`,
        })
      : // Internal details (SQL, paths) stay server-side; the client only
        // learns that something failed.
        new OpenAdeRpcError({ code: "internal", message: "internal error" });

/** The RPC handler layer — every method in the group, one implementation each. */
export const handlersLayer = OpenAdeRpcGroup.toLayer(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const identity = yield* ServerIdentity;
    const connectors = yield* ConnectorCatalog;
    const files = yield* FileService;
    const git = yield* GitService;
    const browser = yield* BrowserService;
    const settings = yield* SettingsStore;
    const cmdConfig = yield* CmdConfig;

    return {
      "server.hello": () =>
        Effect.succeed({
          protocolVersion: PROTOCOL_VERSION,
          serverInstanceId: identity.serverInstanceId,
        }),

      "orchestration.dispatch": ({ command }: { command: Command }) =>
        engine.dispatch(command).pipe(Effect.mapError(toRpcError)),

      "projects.list": () => engine.listProjects().pipe(Effect.mapError(toRpcError)),

      "threads.list": ({ projectId, includeArchived }) =>
        engine.listThreads(projectId, includeArchived ?? false).pipe(Effect.mapError(toRpcError)),

      "threads.subscribe": ({ threadId, afterSequence }) =>
        Stream.unwrap(
          engine
            .subscribeThread(threadId, afterSequence === undefined ? {} : { afterSequence })
            .pipe(Effect.mapError(toRpcError)),
        ),

      "threads.listSubscribe": ({ projectId, afterSequence }) =>
        Stream.unwrap(
          engine
            .subscribeThreadList({
              ...(projectId === undefined ? {} : { projectId }),
              ...(afterSequence === undefined ? {} : { afterSequence }),
            })
            .pipe(Effect.mapError(toRpcError)),
        ),

      "connectors.list": ({ refresh }) => connectors.list(refresh ?? false),
      "connectors.models": ({ instanceId }) => connectors.models(instanceId),

      "files.search": ({ projectId, query, limit }) => files.search(projectId, query, limit),
      "files.read": ({ projectId, path, offset, limit }) =>
        files.read(projectId, path, offset, limit),

      "git.status": ({ projectId }) => git.status(projectId),
      "git.diff": ({ projectId, from, to, path }) => git.diff(projectId, { from, to, path }),
      "checkpoints.list": ({ projectId, threadId }) => git.checkpoints(projectId, threadId),

      "browser.subscribe": ({ threadId }) => browser.subscribe(threadId),
      "browser.humanInput": ({ threadId, input }) =>
        browser.humanInput(threadId, input).pipe(Effect.mapError(toRpcError), Effect.as({})),

      "settings.get": () => settings.get,
      "settings.update": ({ patch }) => settings.update(patch).pipe(Effect.mapError(toRpcError)),
      "settings.subscribe": () => settings.changes,

      "cmdConfig.mcp.list": ({ projectId }) => cmdConfig.mcpList(projectId),
      "cmdConfig.mcp.upsert": ({ projectId, server }) => cmdConfig.mcpUpsert(projectId, server),
      "cmdConfig.mcp.remove": ({ projectId, scope, name }) =>
        cmdConfig.mcpRemove(projectId, scope, name),
      "cmdConfig.skills.list": ({ projectId }) => cmdConfig.skillsList(projectId),

      "keybindings.get": () => Effect.map(settings.get, (doc) => doc.keybindings),
      "keybindings.update": ({ keybindings }) =>
        settings.update({ keybindings }).pipe(
          Effect.map((doc) => doc.keybindings),
          Effect.mapError(toRpcError),
        ),
    };
  }),
);
