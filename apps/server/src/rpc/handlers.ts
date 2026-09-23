/**
 * Wires `OpenAdeRpcGroup` to services. Orchestration reads and writes go to
 * the engine; every other surface resolves to its Tag service, so one can be
 * swapped without touching this file.
 */

import { OpenAdeRpcError, OpenAdeRpcGroup, PROTOCOL_VERSION } from "@OpenAde/contracts/rpc";
import type { Command } from "@OpenAde/contracts/orchestration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { AttachmentStore } from "../attachments/AttachmentStore";
import { ConcurrencyConflict } from "../persistence/EventStore";
import { OrchestrationEngine } from "../orchestration/Engine";
import {
  BrowserService,
  ConnectorCatalog,
  ConnectorExtensions,
  DirectoryBrowser,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
  TerminalService,
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
    const directories = yield* DirectoryBrowser;
    const git = yield* GitService;
    const browser = yield* BrowserService;
    const settings = yield* SettingsStore;
    const extensions = yield* ConnectorExtensions;
    const attachments = yield* AttachmentStore;
    const terminals = yield* TerminalService;

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
      "connectors.describe": () => connectors.describe,

      "files.search": ({ projectId, threadId, query, limit }) =>
        files.search({ projectId, threadId }, query, limit),
      "files.read": ({ projectId, threadId, path, offset, limit }) =>
        files.read({ projectId, threadId }, path, offset, limit),

      "fs.browse": ({ path, showHidden }) => directories.browse({ path, showHidden }),

      "attachments.stage": ({ threadId, name, base64 }) =>
        attachments.stage({ threadId, name, base64 }),
      "attachments.read": ({ threadId, path }) => attachments.read(threadId, path),

      "git.status": ({ projectId, threadId }) => git.status({ projectId, threadId }),
      "git.diff": ({ projectId, threadId, from, to, path, mergeBase }) =>
        git.diff({ projectId, threadId }, { from, to, path, mergeBase }),
      "git.branches": ({ projectId, threadId }) => git.branches({ projectId, threadId }),
      "git.branch.create": ({ projectId, threadId, name, from, checkout }) =>
        git.createBranch({ projectId, threadId }, { name, from, checkout }),
      "git.checkout": ({ projectId, threadId, branch }) =>
        git.checkout({ projectId, threadId }, branch),
      "git.commit": ({ projectId, threadId, message, paths }) =>
        git.commit({ projectId, threadId }, { message, paths }),
      "git.push": ({ projectId, threadId }) => git.push({ projectId, threadId }),
      "git.pullRequest.create": ({ projectId, threadId, title, body, base }) =>
        git.createPullRequest({ projectId, threadId }, { title, body, base }),
      "git.worktree.create": ({ projectId, name, baseBranch }) =>
        git.createWorktree(projectId, { name, baseBranch }),
      "git.worktree.list": ({ projectId }) => git.listWorktrees(projectId),
      "git.worktree.remove": ({ projectId, path, force }) =>
        git.removeWorktree(projectId, { path, force: force ?? false }).pipe(Effect.as({})),
      "git.worktree.setup": ({ projectId, path }) => git.setupWorktree(projectId, path),
      "checkpoints.list": ({ projectId, threadId }) => git.checkpoints(projectId, threadId),

      "browser.subscribe": ({ threadId }) => browser.subscribe(threadId),
      "browser.humanInput": ({ threadId, input }) =>
        browser.humanInput(threadId, input).pipe(Effect.mapError(toRpcError), Effect.as({})),

      "settings.get": () => settings.get,
      "settings.update": ({ patch }) => settings.update(patch).pipe(Effect.mapError(toRpcError)),
      "settings.subscribe": () => settings.changes,

      "connectors.skills.list": ({ instanceId, projectId }) =>
        extensions.skillsList(instanceId, projectId),
      "connectors.skills.available": ({ instanceId }) => extensions.skillsAvailable(instanceId),
      "connectors.skills.link": ({ instanceId, entry }) => extensions.skillsLink(instanceId, entry),
      "connectors.mcp.list": ({ instanceId, projectId }) =>
        extensions.mcpList(instanceId, projectId),
      "connectors.mcp.add": ({ instanceId, projectId, server }) =>
        extensions.mcpAdd(instanceId, projectId, server),
      "connectors.mcp.remove": ({ instanceId, projectId, scope, name }) =>
        extensions.mcpRemove(instanceId, projectId, scope, name),

      "keybindings.get": () => Effect.map(settings.get, (doc) => doc.keybindings),
      "keybindings.update": ({ keybindings }) =>
        settings.update({ keybindings }).pipe(
          Effect.map((doc) => doc.keybindings),
          Effect.mapError(toRpcError),
        ),

      "terminal.open": ({ threadId, terminalId, cols, rows, title }) =>
        terminals.open({ threadId, terminalId, cols, rows, title }),
      "terminal.write": ({ threadId, terminalId, data }) =>
        terminals.write(threadId, terminalId, data).pipe(Effect.as({})),
      "terminal.resize": ({ threadId, terminalId, cols, rows }) =>
        terminals.resize(threadId, terminalId, cols, rows).pipe(Effect.as({})),
      "terminal.close": ({ threadId, terminalId }) =>
        terminals.close(threadId, terminalId).pipe(Effect.as({})),
      "terminal.list": ({ threadId }) => terminals.list(threadId),
      "terminal.subscribe": ({ threadId, terminalId }) => terminals.subscribe(threadId, terminalId),
    };
  }),
);
