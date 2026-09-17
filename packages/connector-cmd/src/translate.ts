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

import * as NodeCrypto from "node:crypto";
import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import { makeItemId, makeTurnId } from "@OpenAde/contracts/ids";
import type {
  ConnectorCapabilities,
  ContentDeltaKind,
  ItemSnapshot,
  RuntimeEvent,
  Todo,
  TurnStopReason,
} from "@OpenAde/contracts/runtime";

import { EXIT_MESSAGES } from "./exitCodes";
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
  /**
   * The id of the newest transcript message folded into items —
   * `meta.messageId`, or the transcript line's own `id` when the message is
   * anonymous. Persisted in the sessionRef so a resumed runtime can dedupe
   * against what a previous process already emitted.
   */
  readonly lastMessageId: string | null;
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

/**
 * A stable key for a message with no `meta.messageId`. The old
 * `anon:<blockIndex>` scheme collapsed every anonymous message's block N onto
 * one itemId and gave anonymous tool_use a fresh key per sighting; hashing
 * role+content dedupes the same message re-seen (tailer then run_end) while
 * keeping different messages apart.
 */
const anonymousKey = (message: TranscriptMessage): string =>
  `anon:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ role: message.role, content: message.content }), "utf8")
    .digest("hex")
    .slice(0, 16)}`;

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

/**
 * Tool results land whole in item snapshots — a build log or a minified file
 * would otherwise inflate the event log and the stream budget. 64KB keeps a
 * useful head and marks the cut.
 */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

const truncateToolOutput = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]`
    : text;

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
  /**
   * The persisted ref's marker on a resumed session. The tailer repositions
   * the file after it; a `nextState` replay that contains it has its
   * already-emitted prefix skipped (a fresh `seenMessages` would otherwise
   * duplicate every message the previous runtime folded).
   */
  readonly resumeAfterMessageId?: string | null;
}): CmdTranslator => {
  let sessionId: string | null = null;
  let announced = false;
  let model: string | null = null;
  let turnOpen = false;
  let lastMessageId: string | null = options.resumeAfterMessageId ?? null;
  let resumeMarker = options.resumeAfterMessageId ?? null;
  /** meta.messageId — or content-hash key — of every message already folded. */
  const seenMessages = new Set<string>();
  /** tool_use.id → minted itemId (the dedupe key across ndjson + transcript). */
  const toolItems = new Map<string, ItemId>();
  /** tool_use.id → the last snapshot emitted for it, for result merging. */
  const toolSnapshots = new Map<string, ItemSnapshot>();
  /** `${messageId}:${blockIndex}` → itemId, so a replayed block hits its row. */
  const blockItems = new Map<string, ItemId>();
  /**
   * Streaming text, for the delta path: the text accumulated so far on each
   * streamed row, and the reverse index the transcript uses to recognize its
   * own finished block. A delta frame that names its message keys the same way
   * the transcript does and needs neither; an anonymous one is matched on the
   * text it built up, which is the only handle the two sources share.
   */
  const streamedText = new Map<string, string>();
  const streamedItemForText = new Map<string, ItemId>();
  let deltaRun = 0;
  /** Cost the transcript reported for this turn's assistant messages. */
  let turnCostUsd = 0;
  const costedLines = new Set<string>();

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
    fallbackKey?: string,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    // No tool_use.id: the containing message's dedupe key + block index is a
    // stable fallback — a key minted per sighting duplicated the row on replay.
    const key = toolUseId ?? fallbackKey ?? `anon:${toolName}:${makeItemId()}`;
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
    const text = truncateToolOutput(textOfToolResult(block.content));
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
    // meta.messageId, or the content hash for a message without one.
    const dedupeKey = messageId ?? anonymousKey(message);
    if (seenMessages.has(dedupeKey)) {
      return [];
    }
    seenMessages.add(dedupeKey);
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
      const key = `${dedupeKey}:${index}`;
      switch (record.type) {
        case "text": {
          const text = asString(record.text) ?? "";
          if (text === "") {
            return;
          }
          // A row already streamed this exact text — finish it rather than
          // open a second one next to it.
          const itemId = streamedItemForText.get(text) ?? itemIdFor(key);
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
          const itemId = streamedItemForText.get(thinking) ?? itemIdFor(key);
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
          out.push(
            ...toolStarted(
              toolUse.id,
              toolUse.name ?? "unknown",
              toolUse.input,
              undefined,
              `tool:${key}`,
            ),
          );
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

  /**
   * `run_end.result.usage` has no cost field (spec 5.2) — the only place a
   * price appears is the transcript's per-assistant `usage.costUsd` (5.3), so
   * the turn's cost is the sum of the lines it wrote. Zero stays absent rather
   * than being reported as a free turn.
   */
  const usageUpdated = (usage: CmdUsage | undefined): PendingRuntimeEvent => {
    const costUsd = turnCostUsd;
    turnCostUsd = 0;
    return {
      type: "usage.updated",
      payload: {
        turnId: makeTurnId(),
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0,
        cacheWrite: usage?.cacheWriteTokens ?? 0,
        ...(costUsd > 0 ? { costUsd } : {}),
      },
    };
  };

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

  /**
   * A streaming frame → `content.delta` on the row its message will finish on.
   *
   * Spec 5.2 says to design for delta frames without having captured one —
   * whether print mode streams text at all is §5.7 question 1 — so this reads
   * every spelling the family uses (`delta.text`, `delta.thinking`,
   * `delta.partial_json`, a bare `text`) off any `*_delta` event, and returns
   * null for anything it cannot read so the frame still surfaces as
   * `event.unmapped` rather than disappearing.
   *
   * Keying is what keeps the later full block from opening a second row. A
   * frame that names its message uses `${messageId}:${index}` — exactly the
   * key `processMessage` mints — and an anonymous one is recognized by the
   * text it accumulated, which `processMessage` looks up before minting.
   */
  const onDelta = (event: {
    readonly type: string;
    readonly [key: string]: unknown;
  }): ReadonlyArray<PendingRuntimeEvent> | null => {
    if (!event.type.endsWith("_delta")) {
      return null;
    }
    const delta = asRecord(event.delta);
    const thinking = asString(delta.thinking);
    const partialJson = asString(delta.partial_json) ?? asString(delta.partialJson);
    const text =
      asString(delta.text) ??
      thinking ??
      partialJson ??
      asString(event.text) ??
      asString(event.delta);
    if (text === undefined || text === "") {
      return null;
    }
    const kind: ContentDeltaKind =
      thinking !== undefined || event.type.includes("thinking")
        ? "reasoning"
        : partialJson !== undefined || event.type.includes("input_json")
          ? "tool_input"
          : "text";
    const messageId =
      asString(event.messageId) ?? asString(event.message_id) ?? asRecord(event.message).id;
    const index = typeof event.index === "number" ? event.index : 0;
    const key =
      typeof messageId === "string" ? `${messageId}:${index}` : `delta:${deltaRun}:${index}`;
    const known = streamedText.get(key);
    const itemId = itemIdFor(key);
    const out: Array<PendingRuntimeEvent> = [];
    if (known === undefined) {
      out.push({
        itemId,
        type: "item.started",
        payload: {
          item: {
            itemId,
            kind: kind === "reasoning" ? "reasoning" : "assistant_message",
            status: "in_progress",
          },
        },
      });
    }
    const full = (known ?? "") + text;
    streamedText.set(key, full);
    streamedItemForText.set(full, itemId);
    out.push({ itemId, type: "content.delta", payload: { itemId, kind, delta: text } });
    return out;
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
        deltaRun += 1;
        return [{ type: "turn.started", payload: { turnId: makeTurnId() } }];
      }
      case "message_start":
      case "model_trace":
      case "notice": {
        return [];
      }
      case "model_request_start": {
        // One model_request_start fires per request, not per change — emit
        // only when the value actually moved or thread.settings.updated
        // spam feeds back into the reactor.
        if (event.model === undefined || event.model === model) {
          return [];
        }
        model = event.model;
        return [{ type: "model.changed", payload: { model: event.model } }];
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
          // On a resumed session the replay can carry the whole history.
          // Everything up to and including the resume marker was already
          // emitted by the previous runtime — skip it rather than dupe.
          let start = 0;
          if (resumeMarker !== null) {
            const index = nextMessages.findIndex(
              (message) => message.meta?.messageId === resumeMarker,
            );
            resumeMarker = null; // authoritative state — the marker won't appear later
            if (index !== -1) {
              start = index + 1;
            }
          }
          for (const message of nextMessages.slice(start)) {
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
        const streamed = onDelta(event);
        return streamed ?? [unmapped("cmd.ndjson", frame)];
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
      const cost = record.usage?.costUsd;
      const costKey = record.message.meta?.messageId ?? record.id;
      if (typeof cost === "number" && cost > 0 && costKey !== undefined) {
        // A resumed tailer can re-read a line it already costed; the id keeps
        // the turn's total honest.
        if (!costedLines.has(costKey)) {
          costedLines.add(costKey);
          turnCostUsd += cost;
        }
      }
      // The newest message seen is the resume marker: meta.messageId when the
      // harness names it, else the transcript line's own id.
      lastMessageId = record.message.meta?.messageId ?? record.id ?? lastMessageId;
      return [...processMessage(record.message)];
    }
    return [unmapped("cmd.transcript", line)];
  };

  const onExit = (code: number): ReadonlyArray<PendingRuntimeEvent> => {
    const out: Array<PendingRuntimeEvent> = [];
    const named = EXIT_MESSAGES[code];
    if (named !== undefined) {
      out.push({ type: "runtime.error", payload: { ...named } });
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
    get lastMessageId() {
      return lastMessageId;
    },
  };
};
