/**
 * The Command Code connector definition: probe, instance creation, session
 * start/resume. Everything else — spawn, frames, transcript, translation —
 * lives in the sibling modules this wires together. Sessions come back raw;
 * the engine's SessionManager adds the turn-scoped wrapper.
 */
import type { ConnectorDefinition, StartSessionInput } from "@OpenAde/connector-sdk/definition";
import { SpawnFailed } from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { resolveForSession } from "./binary";
import { CmdConnectorConfig } from "./configSchema";
import { probe as probeBinary } from "./probe";
import { CMD_CAPABILITIES } from "./capabilities";
import { makeCmdSession, type CmdSessionRef } from "./session";

export const CMD_KIND = "cmd";

const asSessionRef = (ref: unknown): CmdSessionRef | undefined => {
  if (typeof ref !== "object" || ref === null) return undefined;
  const record = ref as {
    sessionId?: unknown;
    transcriptPath?: unknown;
    cwd?: unknown;
    lastMessageId?: unknown;
  };
  if (
    typeof record.sessionId !== "string" ||
    typeof record.transcriptPath !== "string" ||
    typeof record.cwd !== "string"
  ) {
    return undefined;
  }
  // Older persisted refs predate the marker — missing is the same as null.
  const lastMessageId = typeof record.lastMessageId === "string" ? record.lastMessageId : null;
  return {
    sessionId: record.sessionId,
    transcriptPath: record.transcriptPath,
    cwd: record.cwd,
    lastMessageId,
  };
};

export const cmdConnectorDefinition: ConnectorDefinition<CmdConnectorConfig> = {
  kind: CMD_KIND,
  metadata: {
    displayName: "Command Code",
    iconKey: "terminal",
    accent: "#6e56cf",
    // The docs root the CLI's own `--help` points at (fixtures/cmd/probe/help.stdout.txt).
    docsUrl: "https://commandcode.ai/docs",
  },
  configSchema: CmdConnectorConfig,
  defaultConfig: () => ({}),
  probe: (config) => probeBinary(config),
  createInstance: ({ instanceId, config, services }) => {
    const spawnSession = (input: StartSessionInput, sessionRef?: CmdSessionRef) =>
      makeCmdSession({
        instanceId,
        threadId: input.threadId,
        workspaceRoot: input.workspaceRoot,
        ...(config.binaryPath === undefined ? {} : { binaryPath: config.binaryPath }),
        // The same resolution the probe reports, carried into the spawn instead
        // of discarded: the server's own PATH is not where `cmd` necessarily
        // is, and the npx fallback is not a binary at all (`binary.ts`).
        // Resolved per session start, so an install that appears later is found.
        binary: resolveForSession(config, process.env),
        ...(config.extraEnv === undefined ? {} : { extraEnv: config.extraEnv }),
        // The child resolves `~/.commandcode` against its own HOME,
        // and extraEnv is what sets that HOME. Without this the tailer watches
        // the server's home instead and the timeline loses every streaming
        // item until the run_end reconcile.
        ...(config.extraEnv?.HOME === undefined ? {} : { home: config.extraEnv.HOME }),
        services,
        settings: input.settings,
        ...(sessionRef === undefined ? {} : { sessionRef }),
      });
    return Effect.succeed({
      instanceId,
      kind: CMD_KIND,
      capabilities: CMD_CAPABILITIES,
      startSession: (input) => spawnSession(input),
      resumeSession: (input) => spawnSession(input, asSessionRef(input.sessionRef)),
      listModels: () =>
        probeBinary(config).pipe(
          Effect.map((probe) => probe.models),
          Effect.mapError(
            (error) =>
              new SpawnFailed({
                kind: CMD_KIND,
                instanceId,
                message: error.message,
              }),
          ),
        ),
    });
  },
};
