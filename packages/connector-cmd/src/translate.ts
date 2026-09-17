/**
 * Command Code frames and transcript lines → `RuntimeEvent`s.
 *
 * Three sources describe the same work and overlap heavily: NDJSON frames on
 * stdout (spec 5.2), the session transcript on disk (5.3), and — on `run_end` —
 * `nextState.messages`, the authoritative message list. The translator's job is
 * to make the overlap idempotent:
 *
 * - tool calls dedupe on `tool_use.id`: a `tool_running` frame and the
 *   transcript's `tool_use` block produce one `itemId`, so the second source
 *   updates rather than duplicates.
 * - messages dedupe on `meta.messageId`: the transcript append and the
 *   `run_end` reconcile both feed through the same message path.
 * - `turn.completed` emits exactly once per run: `run_end` normally closes it,
 *   `onExit` is the backstop for a process that died mid-turn.
 *
 * Item ids are minted — the harness's `toolCallId`/`messageId` are not UUIDv7
 * and the wire schema insists on it — and kept in maps so a later event for
 * the same work lands on the same timeline row.
 */

import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import { makeItemId, makeTurnId } from "@OpenAde/contracts/ids";
import type {
  ConnectorCapabilities,
  ItemSnapshot,
  RuntimeEvent,
  Todo,
  TurnStopReason,
} from "@OpenAde/contracts/runtime";

import type { CmdFrame, CmdUsage } from "./ndjson";

/**
 * A `RuntimeEvent` minus the envelope fields the session stamps on the way
 * out — the same shape testkit's `ScriptedRuntimeEvent` uses.
 */
type WithoutEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "eventId" | "connectorInstanceId" | "threadId" | "createdAt">
  : never;

export type PendingRuntimeEvent = WithoutEnvelope<RuntimeEvent>;

export interface CmdTranslator {
  /** One stdout frame → the events it means. */
  readonly onFrame: (frame: CmdFrame) => ReadonlyArray<PendingRuntimeEvent>;
  /** One transcript line, already JSON-parsed → the events it means. */
  readonly onTranscriptLine: (line: unknown) => ReadonlyArray<PendingRuntimeEvent>;
  /** Process exit → the events that settle whatever is still open. */
  readonly onExit: (code: number) => ReadonlyArray<PendingRuntimeEvent>;
  /** The session id learned from `run_start` (or the transcript header). */
  readonly sessionId: string | null;
}

// ── transcript shapes (spec 5.3, only what we read) ────────────

interface TranscriptMeta {
  readonly source?: string;
  readonly createdAt?: number;
  readonly messageId?: string;
}

interface TranscriptMessage {
  readonly role?: string;
  readonly content?: ReadonlyArray<unknown>;
  readonly meta?: TranscriptMeta;
}

interface TranscriptLine {
  readonly type?: string;
  readonly id?: string;
  readonly parentId?: string;
  readonly timestamp?: string;
  readonly message?: TranscriptMessage;
  readonly usage?: CmdUsage & { readonly costUsd?: number };
  readonly model?: string;
}

interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

// ── tool vocabulary (spec 5.4) ─────────────────────────────────

const TOOL_KIND: Readonly<Record<string, ItemKind>> = {
  shell_command: "command_execution",
  edit_file: "file_change",
  write_file: "file_change",
  read_file: "tool_call",
  read_directory: "tool_call",
  glob: "tool_call",
  grep: "tool_call",
  todo_write: "todo",
  agent: "task",
  activate_skill: "skill",
  web_search: "web_search",
  web_fetch: "web_search",
};

const kindForTool = (name: string): ItemKind =>
  name.startsWith("mcp__") ? "mcp_tool_call" : (TOOL_KIND[name] ?? "tool_call");

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `mcp__<server>__<tool>` → server; undefined for ordinary tools. */
const mcpServerOf = (name: string): string | undefined => {
  if (!name.startsWith("mcp__")) {
    return undefined;
  }
  const rest = name.slice(5);
  const separator = rest.indexOf("__");
  return separator === -1 ? rest : rest.slice(0, separator);
};

const textOfToolResult = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => asString(asRecord(block).text))
      .filter((text): text is string => text !== undefined)
      .join("\n");
  }
  return "";
};

const todosOf = (input: Record<string, unknown>): ReadonlyArray<Todo> =>
  (Array.isArray(input.todos) ? input.todos : []).flatMap((todo, index) => {
    const record = asRecord(todo);
    const text = asString(record.text) ?? asString(record.content) ?? asString(record.title);
    if (text === undefined || text === "") {
      return [];
    }
    const status = asString(record.status);
    return [
      {
        todoId: asString(record.id) ?? asString(record.todoId) ?? `todo-${index}`,
        text,
        status: status === "in_progress" || status === "completed" ? status : ("pending" as const),
      } satisfies Todo,
    ];
  });

// ── the translator ─────────────────────────────────────────────

export const makeTranslator = (options: {
  readonly connectorInstanceId: unknown;
  readonly capabilities: ConnectorCapabilities;
}): CmdTranslator => {
  let sessionId: string | null = null;
  let announced = false;
  let model: string | null = null;
  let turnOpen = false;
  /** meta.messageId of every message already folded into items. */
  const seenMessages = new Set<string>();
  /** tool_use.id → minted itemId (the dedupe key across ndjson + transcript). */
  const toolItems = new Map<string, ItemId>();
  /** tool_use.id → the last snapshot emitted for it, for result merging. */
  const toolSnapshots = new Map<string, ItemSnapshot>();
  /** `${messageId}:${blockIndex}` → itemId, so a replayed block hits its row. */
  const blockItems = new Map<string, ItemId>();

  const unmapped = (source: string, payload: unknown): PendingRuntimeEvent => ({
    type: "event.unmapped",
    payload: {},
    raw: { source, payload },
  });

  const itemIdFor = (key: string): ItemId => {
    const existing = blockItems.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const itemId = makeItemId();
    blockItems.set(key, itemId);
    return itemId;
  };

  /** The snapshot a tool call announces — what `tool_running` knows, or full `input`. */
  const snapshotForTool = (
    itemId: ItemId,
    toolName: string,
    input: unknown,
    description?: string,
  ): ItemSnapshot => {
    const record = asRecord(input);
    const kind = kindForTool(toolName);
    const base: ItemSnapshot = {
      itemId,
      kind,
      status: "in_progress",
      ...(description === undefined ? {} : { text: description }),
    };
    switch (kind) {
      case "command_execution": {
        const cmd = asString(record.command) ?? description ?? toolName;
        return {
          ...base,
          command: {
            cmd,
            ...(asString(record.cwd) === undefined ? {} : { cwd: asString(record.cwd) }),
          },
        };
      }
      case "file_change": {
        const path = asString(record.file_path) ?? asString(record.path) ?? toolName;
        return {
          ...base,
          fileChange: {
            path,
            kind: toolName === "write_file" ? "create" : "edit",
          },
          tool: { name: toolName, input },
        };
      }
      case "todo": {
        return { ...base, todos: [...todosOf(record)] };
      }
      case "mcp_tool_call": {
        const server = mcpServerOf(toolName);
        return {
          ...base,
          tool: { name: toolName, ...(server === undefined ? {} : { server }), input },
        };
      }
      default: {
        return { ...base, tool: { name: toolName, input } };
      }
    }
  };

  /** A tool_use block/frame → item.started (first sight) or item.updated (known id). */
  const toolStarted = (
    toolUseId: string | undefined,
    toolName: string,
    input: unknown,
    description?: string,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const key = toolUseId ?? `anon:${toolName}:${makeItemId()}`;
    const existing = toolItems.get(key);
    if (existing !== undefined) {
      const prior = toolSnapshots.get(key);
      const next = snapshotForTool(existing, toolName, input, description);
      // Never regress a finished row back to in_progress on a late duplicate.
      const snapshot = prior === undefined ? next : { ...prior, ...next, status: prior.status };
      toolSnapshots.set(key, snapshot);
      return [{ itemId: existing, type: "item.updated", payload: { item: snapshot } }];
    }
    const itemId = makeItemId();
    toolItems.set(key, itemId);
    const snapshot = snapshotForTool(itemId, toolName, input, description);
    toolSnapshots.set(key, snapshot);
    return [{ itemId, type: "item.started", payload: { item: snapshot } }];
  };

  /** A tool_result block → item.completed on the row the tool_use opened. */
  const toolCompleted = (block: ToolResultBlock): ReadonlyArray<PendingRuntimeEvent> => {
    const text = textOfToolResult(block.content);
    const existing = block.tool_use_id === undefined ? undefined : toolItems.get(block.tool_use_id);
    const itemId = existing ?? makeItemId();
    const prior = existing === undefined ? undefined : toolSnapshots.get(block.tool_use_id!);
    const status = block.is_error === true ? ("failed" as const) : ("completed" as const);
    const snapshot: ItemSnapshot =
      prior !== undefined
        ? {
            ...prior,
            status,
            ...(prior.command !== undefined ? { command: { ...prior.command, output: text } } : {}),
            ...(prior.tool !== undefined ? { tool: { ...prior.tool, output: text } } : {}),
            ...(block.is_error === true ? { error: { message: text } } : {}),
          }
        : {
            itemId,
            kind: "tool_call",
            status,
            tool: { name: "tool", input: {}, output: text },
            ...(block.is_error === true ? { error: { message: text } } : {}),
          };
    if (block.tool_use_id !== undefined) {
      toolItems.set(block.tool_use_id, itemId);
      toolSnapshots.set(block.tool_use_id, snapshot);
    }
    return [{ itemId, type: "item.completed", payload: { item: snapshot } }];
  };

  /**
   * One transcript/nextState message → its items. `messageId` dedupe is what
   * makes the run_end reconcile free to repeat what the tailer already saw.
   */
  const processMessage = (message: TranscriptMessage): ReadonlyArray<PendingRuntimeEvent> => {
    const meta = message.meta ?? {};
    const messageId = meta.messageId;
    if (messageId !== undefined && seenMessages.has(messageId)) {
      return [];
    }
    if (messageId !== undefined) {
      seenMessages.add(messageId);
    }
    const out: Array<PendingRuntimeEvent> = [];
    const content = Array.isArray(message.content) ? message.content : [];

    if (message.role === "user") {
      const results = content.filter(
        (block): block is ToolResultBlock => asRecord(block).type === "tool_result",
      );
      if (meta.source === "tool" || results.length > 0) {
        for (const block of results) {
          out.push(...toolCompleted(block));
        }
      }
      // A user *text* message emits nothing: the engine's turn.requested fold
      // already mints the user_message row — a second one here would show
      // every prompt twice.
      return out;
    }

    if (message.role !== "assistant") {
      return out;
    }

    content.forEach((block, index) => {
      const record = asRecord(block);
      const key = `${messageId ?? "anon"}:${index}`;
      switch (record.type) {
        case "text": {
          const text = asString(record.text) ?? "";
          if (text === "") {
            return;
          }
          const itemId = itemIdFor(key);
          out.push({
            itemId,
            type: "item.completed",
            payload: {
              item: {
                itemId,
                kind: "assistant_message",
                status: "completed",
                text,
              },
            },
          });
          return;
        }
        case "thinking": {
          const thinking = asString(record.thinking) ?? "";
          if (thinking === "") {
            return;
          }
          const itemId = itemIdFor(key);
          out.push({
            itemId,
            type: "item.completed",
            payload: {
              item: {
                itemId,
                kind: "reasoning",
                status: "completed",
                text: thinking,
              },
            },
          });
          return;
        }
        case "tool_use": {
          const toolUse = record as unknown as ToolUseBlock;
          out.push(...toolStarted(toolUse.id, toolUse.name ?? "unknown", toolUse.input, undefined));
          return;
        }
        case "tool_result": {
          out.push(...toolCompleted(record as unknown as ToolResultBlock));
          return;
        }
        default: {
          out.push(unmapped("cmd.transcript", { block }));
          return;
        }
      }
    });
    return out;
  };

  const usageUpdated = (usage: CmdUsage | undefined): PendingRuntimeEvent => ({
    type: "usage.updated",
    payload: {
      turnId: makeTurnId(),
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
    },
  });

  const stopReasonFor = (reason: string | undefined): TurnStopReason => {
    switch (reason) {
      case "end_turn":
      case "stop":
        return "end_turn";
      case "interrupted":
      case "cancelled":
        return "interrupted";
      case "max_turns":
        return "max_turns";
      default:
        return "error";
    }
  };

  const completeTurn = (stopReason: TurnStopReason): PendingRuntimeEvent => {
    turnOpen = false;
    return { type: "turn.completed", payload: { turnId: makeTurnId(), stopReason } };
  };

  const onRunStart = (event: { sessionId?: string }): ReadonlyArray<PendingRuntimeEvent> => {
    const id = event.sessionId;
    // A second run_start for the same session is the next turn's process —
    // announce once. A *different* id means the resume landed on a fresh
    // session, which the engine needs to hear about.
    if (announced && (id === undefined || id === sessionId)) {
      turnOpen = true;
      return [];
    }
    if (id !== undefined) {
      sessionId = id;
    }
    announced = true;
    turnOpen = true;
    return [
      {
        type: "session.started",
        payload: {
          sessionRef: { sessionId, transcriptPath: null, cwd: null },
          model: model ?? "unknown",
          capabilities: options.capabilities,
        },
      },
    ];
  };

  const onFrame = (frame: CmdFrame): ReadonlyArray<PendingRuntimeEvent> => {
    if (frame.type === "result") {
      const out: Array<PendingRuntimeEvent> = [];
      if (frame.subtype === "error") {
        out.push({
          type: "runtime.error",
          payload: { message: frame.error ?? "command code run failed", fatal: true },
        });
      }
      if (turnOpen) {
        out.push(
          completeTurn(
            frame.subtype === "max_turns"
              ? "max_turns"
              : frame.subtype === "error"
                ? "error"
                : "end_turn",
          ),
        );
      }
      return out;
    }

    const event = frame.event;
    switch (event.type) {
      case "run_start": {
        return [...onRunStart(event)];
      }
      case "turn_start": {
        turnOpen = true;
        return [{ type: "turn.started", payload: { turnId: makeTurnId() } }];
      }
      case "message_start":
      case "model_trace":
      case "notice": {
        return [];
      }
      case "model_request_start": {
        if (event.model !== undefined) {
          model = event.model;
        }
        return event.model === undefined
          ? []
          : [{ type: "model.changed", payload: { model: event.model } }];
      }
      case "tool_running": {
        return [
          ...toolStarted(event.toolCallId, event.toolName ?? "unknown", {}, event.description),
        ];
      }
      case "run_error": {
        return [
          {
            type: "runtime.error",
            payload: {
              message: event.error?.message ?? event.error?.name ?? "run failed",
              fatal: true,
            },
          },
        ];
      }
      case "run_end": {
        const result = event.result ?? {};
        const out: Array<PendingRuntimeEvent> = [];
        // nextState is authoritative (spec 5.2): replay any messages the
        // streaming sources missed — dedupe makes it a no-op otherwise.
        const nextMessages = (result.nextState as { messages?: ReadonlyArray<TranscriptMessage> })
          ?.messages;
        if (Array.isArray(nextMessages)) {
          for (const message of nextMessages) {
            out.push(...processMessage(message));
          }
        }
        out.push(usageUpdated(result.usage));
        if (turnOpen) {
          out.push(completeTurn(stopReasonFor(result.stopReason)));
        }
        return out;
      }
      default: {
        return [unmapped("cmd.ndjson", frame)];
      }
    }
  };

  const onTranscriptLine = (line: unknown): ReadonlyArray<PendingRuntimeEvent> => {
    if (typeof line !== "object" || line === null) {
      return [unmapped("cmd.transcript", line)];
    }
    const record = line as TranscriptLine;
    if (record.type === "session") {
      if (typeof record.id === "string") {
        sessionId = record.id;
      }
      return [];
    }
    if (record.type === "message" && record.message !== undefined) {
      if (typeof record.model === "string") {
        model = record.model;
      }
      return [...processMessage(record.message)];
    }
    return [unmapped("cmd.transcript", line)];
  };

  const onExit = (code: number): ReadonlyArray<PendingRuntimeEvent> => {
    const out: Array<PendingRuntimeEvent> = [];
    // Exit-code mapping (spec 5.1): 3 auth, 10 credits, 8 max turns, 130 interrupt.
    if (code === 3) {
      out.push({
        type: "runtime.error",
        payload: { message: "command code is not authenticated — run `cmd login`", fatal: true },
      });
    } else if (code === 10) {
      out.push({
        type: "runtime.error",
        payload: {
          message: "insufficient credits — top up at https://commandcode.ai/billing and retry",
          fatal: true,
        },
      });
    } else if (code !== 0 && code !== 130) {
      out.push({
        type: "runtime.error",
        payload: { message: `cmd exited with code ${code}`, fatal: true },
      });
    }
    if (turnOpen) {
      out.push(
        completeTurn(
          code === 130
            ? "interrupted"
            : code === 8
              ? "max_turns"
              : code === 0
                ? "end_turn"
                : "error",
        ),
      );
    }
    return out;
  };

  return {
    onFrame,
    onTranscriptLine,
    onExit,
    get sessionId() {
      return sessionId;
    },
  };
};
