/**
 * The SDK options one session's `query()` is started with.
 *
 * - The CLI is the user's own binary (`pathToClaudeCodeExecutable`), started
 *   through `spawn.ts` in a process group of its own, with the default-deny
 *   environment of `env.ts`.
 * - The session loads the user's harness as the CLI would —
 *   `settingSources` user, project and local, so their CLAUDE.md, skills, MCP
 *   servers and hooks all apply — under the CLI's own system prompt.
 * - OpenAde's MCP server is added as `openade`, over HTTP to the per-thread
 *   endpoint with its bearer. The SDK hands the CLI its MCP config on the
 *   command line, so the bearer is visible to `ps` on this machine for the
 *   session's life; it is minted per session and revoked with it.
 * - Every tool call is gated (`toolGate.ts`).
 * - The thread's attachments directory is readable, so a file the user
 *   attached can be read by path.
 */

import * as NodePath from "node:path";
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorEndpoint } from "@OpenAde/connector-sdk/definition";
import type { Effort } from "@OpenAde/contracts/enums";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";

import { sdkModelFor } from "./models";
import type { ClaudeSpawnOptions, ClaudeSpawnedProcess } from "./spawn";
import type { ToolGate } from "./toolGate";

/** The name OpenAde's MCP server is registered under in the session. */
const OPENADE_MCP_SERVER = "openade";

/**
 * The CLI permission mode for a thread's modes. A plan turn runs in `plan`;
 * otherwise ask, auto-accept edits and full access are the CLI's `default`,
 * `acceptEdits` and `bypassPermissions`. Whichever it is, the PreToolUse hook
 * still puts every call past OpenAde's ladder first.
 */
export const permissionModeFor = (settings: ThreadSettings): PermissionMode => {
  if (settings.interactionMode === "plan") return "plan";
  switch (settings.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
};

/** The SDK's effort for ours; `minimal` has no rung in the CLI and is left out. */
export const sdkEffortFor = (effort: Effort | undefined): EffortLevel | undefined =>
  effort === undefined || effort === "minimal" ? undefined : effort;

/** The directory a thread's attachments are staged under. */
export const attachmentsDirFor = (attachmentsDir: string, threadId: ThreadId): string =>
  NodePath.join(NodePath.resolve(attachmentsDir), threadId);

/** Limits only a recording sets, so a live run cannot spend beyond them. */
export interface SessionLimits {
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}

export interface QueryOptionsInput {
  readonly binaryPath: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** A fresh session's id, minted by us. */
  readonly sessionId?: string;
  /** The session to resume instead. */
  readonly resume?: string;
  readonly settings: ThreadSettings;
  readonly mcp: ConnectorEndpoint;
  readonly attachmentsDir: string;
  readonly abortController: AbortController;
  readonly spawn: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
  readonly gate: ToolGate;
  readonly limits?: SessionLimits;
}

export const buildQueryOptions = (input: QueryOptionsInput): Options => {
  const model = sdkModelFor(input.settings.model);
  const effort = sdkEffortFor(input.settings.effort);
  const preToolUse: HookCallback = (hookInput) => input.gate.preToolUse(hookInput);
  const canUseTool: CanUseTool = (toolName, toolInput, options) =>
    input.gate.canUseTool(toolName, toolInput, options);
  return {
    pathToClaudeCodeExecutable: input.binaryPath,
    env: input.env,
    cwd: input.cwd,
    spawnClaudeCodeProcess: input.spawn,
    abortController: input.abortController,
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    permissionMode: permissionModeFor(input.settings),
    // The SDK requires it before `bypassPermissions` — full access — can be
    // used, whether at start or by a switch mid-session. The hook still gates
    // every call in that mode.
    allowDangerouslySkipPermissions: true,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    mcpServers: {
      [OPENADE_MCP_SERVER]: {
        type: "http",
        url: input.mcp.url,
        headers: { Authorization: `Bearer ${input.mcp.bearer}` },
      },
    },
    additionalDirectories: [input.attachmentsDir],
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    canUseTool,
    ...(input.limits?.maxTurns === undefined ? {} : { maxTurns: input.limits.maxTurns }),
    ...(input.limits?.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: input.limits.maxBudgetUsd }),
  };
};
