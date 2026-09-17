/**
 * The Command Code connector definition: probe, instance creation, session
 * start/resume. Everything else — spawn, frames, transcript, translation —
 * lives in the sibling modules this wires together. Sessions come back raw;
 * the engine's SessionManager adds the turn-scoped wrapper.
 */
import type { CmdConnectorConfig } from "@OpenAde/contracts/settings";
import { CmdConnectorConfig as CmdConnectorConfigSchema } from "@OpenAde/contracts/settings";
import type { ConnectorDefinition, StartSessionInput } from "@OpenAde/connector-sdk/definition";
import { SpawnFailed } from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { probe as probeBinary } from "./probe";
import { makeCmdSession, CMD_CAPABILITIES, type CmdSessionRef } from "./session";

export const CMD_KIND = "cmd";

const asSessionRef = (ref: unknown): CmdSessionRef | undefined => {
  if (typeof ref !== "object" || ref === null) return undefined;
  const record = ref as { sessionId?: unknown; transcriptPath?: unknown; cwd?: unknown };
  return typeof record.sessionId === "string" &&
    typeof record.transcriptPath === "string" &&
    typeof record.cwd === "string"
    ? { sessionId: record.sessionId, transcriptPath: record.transcriptPath, cwd: record.cwd }
    : undefined;
};

export const cmdConnectorDefinition: ConnectorDefinition<CmdConnectorConfig> = {
  kind: CMD_KIND,
  displayName: "Command Code",
  configSchema: CmdConnectorConfigSchema as never,
  defaultConfig: () => ({}),
  probe: (config) => probeBinary(config),
  createInstance: ({ instanceId, config, services }) => {
    const spawnSession = (input: StartSessionInput, sessionRef?: CmdSessionRef) =>
      makeCmdSession({
        instanceId,
        threadId: input.threadId,
        workspaceRoot: input.workspaceRoot,
        ...(config.binaryPath === undefined ? {} : { binaryPath: config.binaryPath }),
        ...(config.extraEnv === undefined ? {} : { extraEnv: config.extraEnv }),
        ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
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
