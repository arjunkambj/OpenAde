/**
 * Every tool call a Claude Code session makes goes past OpenAde's permission
 * ladder first. This is where that is wired into the SDK.
 *
 * The SDK offers two ways in, and neither is enough alone:
 *
 * - `canUseTool` is only asked when the CLI itself would prompt. Calls its own
 *   rules already allow — reads, the user's `~/.claude` allow list, anything
 *   under `bypassPermissions` — never reach it, so a ladder that says "ask"
 *   for one of those would be skipped: the rule that "ask" outranks "allow"
 *   would not hold.
 * - A `PreToolUse` hook runs for every call, in every permission mode.
 *
 * So the hook asks the ladder for every call and answers with its verdict:
 * `allow`, `deny`, or — when the ladder says "prompt" — `ask`, which hands the
 * call to the CLI's permission flow and so to `canUseTool`. `canUseTool` runs
 * the shared approval gate, which asks the ladder again (the same answer) and
 * opens the card. The hook never waits for the user, so no hook timeout can
 * ever decide a call.
 *
 * Both fail closed. A hook that cannot reach a verdict answers `ask`, and a
 * `canUseTool` that cannot answers `deny`; a missing verdict never reads as
 * allow.
 *
 * The request is generic for now — kind `other`, the bare tool name as the
 * "allow always" pattern — a kind the ladder never allows by itself short of
 * full access.
 */

import type { ApprovalGate } from "@OpenAde/connector-sdk/approvalGate";
import type { ConnectorPermissions, PermissionDecision } from "@OpenAde/connector-sdk/definition";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { makeRequestId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import * as Effect from "effect/Effect";

/** The PreToolUse output this sends back, in the SDK's shape. */
export interface PreToolUseOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
  };
}

/** `canUseTool`'s answer, in the SDK's shape. */
export type ToolPermission =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string };

/** What the model is told when OpenAde's rules refuse a call. */
export const DENIED_BY_RULES = "Denied by the user's permission rules in OpenAde.";
/** What the model is told when the user refuses a call. */
export const DENIED_BY_USER = "The user denied this tool call.";

export const requestFor = (toolName: string, input: unknown): ApprovalRequest => ({
  requestId: makeRequestId(),
  kind: "other",
  toolName: toolName === "" ? "unknown" : toolName,
  input,
  patternSuggestion: toolName === "" ? "unknown" : toolName,
  description: `Use ${toolName === "" ? "a tool" : toolName}`,
});

export interface ToolGate {
  readonly preToolUse: (input: unknown) => Promise<PreToolUseOutput>;
  readonly canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { readonly signal: AbortSignal },
  ) => Promise<ToolPermission>;
}

export const makeToolGate = (options: {
  readonly threadId: ThreadId;
  readonly permissions: ConnectorPermissions;
  readonly gate: ApprovalGate;
  /** The thread's settings as they are now — read per call, never captured. */
  readonly settings: () => ThreadSettings;
  /** Runs an effect from the SDK's promise callbacks, in the session's context. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
}): ToolGate => {
  const modes = () => {
    const settings = options.settings();
    return { runtimeMode: settings.runtimeMode, interactionMode: settings.interactionMode };
  };

  const preToolUse = async (input: unknown): Promise<PreToolUseOutput> => {
    const record = (typeof input === "object" && input !== null ? input : {}) as {
      readonly hook_event_name?: unknown;
      readonly tool_name?: unknown;
      readonly tool_input?: unknown;
    };
    if (record.hook_event_name !== "PreToolUse") return {};
    const toolName = typeof record.tool_name === "string" ? record.tool_name : "";
    const verdict = await options
      .run(
        options.permissions
          .decide({
            request: requestFor(toolName, record.tool_input),
            threadId: options.threadId,
            ...modes(),
          })
          .pipe(Effect.catchDefect(() => Effect.succeed<PermissionDecision>("prompt"))),
      )
      .catch((): PermissionDecision => "prompt");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict === "allow" ? "allow" : verdict === "deny" ? "deny" : "ask",
        ...(verdict === "deny" ? { permissionDecisionReason: DENIED_BY_RULES } : {}),
      },
    };
  };

  const canUseTool: ToolGate["canUseTool"] = async (toolName, input, { signal }) => {
    if (signal.aborted) return { behavior: "deny", message: DENIED_BY_USER };
    try {
      const verdict = await options.run(
        options.gate.decide({
          request: requestFor(toolName, input),
          threadId: options.threadId,
          ...modes(),
        }),
      );
      if (verdict.allowed) return { behavior: "allow", updatedInput: input };
      return {
        behavior: "deny",
        message: verdict.via === "user" ? DENIED_BY_USER : DENIED_BY_RULES,
      };
    } catch {
      return { behavior: "deny", message: DENIED_BY_RULES };
    }
  };

  return { preToolUse, canUseTool };
};
