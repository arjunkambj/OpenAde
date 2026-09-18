/**
 * Command Code frames and transcript lines → `RuntimeEvent`s.
 *
 * Three sources describe the same work and overlap heavily: NDJSON frames on
 * stdout (spec 5.2), the session transcript on disk (5.3), and — on `run_end` —
 * `nextState.messages`, the authoritative message list.
 *
 * **Which source is live.** The recordings under `packages/testkit/fixtures/cmd`
 * settle what spec 5.7 left open. Text and thinking stream as `text_delta` /
 * `thinking_delta`, tool calls arrive as a `tool_queued` → `tool_running` →
 * `tool_completed` lifecycle, and the transcript is *not* a live source: it
 * appears seconds into the turn and then grows once per completed message, one
 * whole model round trip behind the frames. So the frames drive the UI and the
 * transcript is history — the thing that survives a restart, carries `costUsd`,
 * and lets a resumed session pick up where a dead one stopped.
 *
 * **What a "turn" is.** The harness's `turn_start`/`turn_end` count *agent
 * steps* — one model round trip each, three of them in `shell-allow/`. One user
 * turn is one process: `run_start` to `run_end`. Mapping `turn_start` to
 * `turn.started` emitted three `turn.started` events for one turn and one
 * `turn.completed`; spec section 8 step 5 says `run_start` opens the turn, and
 * that is what happens here.
 *
 * The translator's remaining job is to make the overlap idempotent:
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

import type { ItemId } from "@OpenAde/contracts/ids";
import { makeItemId, makeTurnId } from "@OpenAde/contracts/ids";
import type {
  ConnectorCapabilities,
  ContentDeltaKind,
  TurnStopReason,
} from "@OpenAde/contracts/runtime";

import { EXIT_MESSAGES } from "./exitCodes";
import {
  anonymousKey,
  asOptionalString,
  asRecord,
  asString,
  makeToolRows,
  textOfToolResult,
  truncateToolOutput,
  type PendingRuntimeEvent,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptLine,
  type TranscriptMessage,
} from "./items";
import type { CmdFrame, CmdUsage } from "./ndjson";
import { subagentProgress } from "./subagents";

export type { PendingRuntimeEvent } from "./items";

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
  /** A tool call's row, however many frames and transcript lines describe it. */
  const toolRows = makeToolRows();
  /** tool_use.id → minted itemId (the dedupe key across ndjson + transcript). */
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
  /** Tokens the run's agent steps have reported so far (`turn_end.usage`). */
  let turnUsage: CmdUsage = {};

  /**
   * A run's counters, zeroed when the next process announces itself.
   *
   * Not at `turn.completed`, which is where they used to be cleared: the
   * transcript is the only source of `costUsd` and its last flush lands *with*
   * or after `run_end`, so a cost cleared at turn end was a cost never reported.
   * The same goes for `streamedItemForText`, which is how a transcript line
   * arriving after the turn finds the row it already streamed on — it now lives
   * as long as the session, beside `seenMessages` and `blockItems`.
   */
  const forgetRun = (): void => {
    streamedText.clear();
    turnCostUsd = 0;
    turnUsage = {};
  };

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
          out.push(...toolRows.completed(block));
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
            ...toolRows.started(
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
          out.push(...toolRows.completed(record as unknown as ToolResultBlock));
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
   * The content blocks of a `message_end` frame → the events that settle them.
   *
   * This is `processMessage`'s job done from the live side, and it shares every
   * dedupe key with it: text and thinking find the row they streamed on through
   * `streamedItemForText`, tool calls key on `toolCallId`. The transcript
   * replaying the same message later therefore lands on the same rows instead of
   * opening a second set beside them.
   */
  const onMessageContent = (content: unknown): ReadonlyArray<PendingRuntimeEvent> => {
    if (!Array.isArray(content)) {
      return [];
    }
    const out: Array<PendingRuntimeEvent> = [];
    content.forEach((block, index) => {
      const record = asRecord(block);
      switch (record.type) {
        case "text":
        case "thinking": {
          const text = asOptionalString(record.type === "text" ? record.text : record.thinking);
          if (text === undefined) {
            return;
          }
          const kind =
            record.type === "text" ? ("assistant_message" as const) : ("reasoning" as const);
          // A model that streams no deltas still gets a row: mint one, and
          // register it so the transcript recognizes it as already emitted.
          const itemId =
            streamedItemForText.get(text) ?? itemIdFor(`message_end:${deltaRun}:${index}`);
          streamedItemForText.set(text, itemId);
          out.push({
            itemId,
            type: "item.completed",
            payload: { item: { itemId, kind, status: "completed", text } },
          });
          return;
        }
        case "tool_use": {
          const toolUse = record as unknown as ToolUseBlock;
          out.push(...toolRows.started(toolUse.id, toolUse.name ?? "unknown", toolUse.input));
          return;
        }
        default: {
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
  /**
   * Every `usage.updated` is a snapshot of the run so far, never a delta: the
   * counters are cumulative and are zeroed only when the next process starts
   * (`forgetRun`). A turn whose price arrives late therefore restates the whole
   * figure rather than asking the consumer to add up instalments.
   */
  const usageUpdated = (
    usage: CmdUsage | undefined,
    options_: { readonly withCost: boolean },
  ): PendingRuntimeEvent => {
    const costUsd = turnCostUsd;
    return {
      type: "usage.updated",
      payload: {
        turnId: makeTurnId(),
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0,
        cacheWrite: usage?.cacheWriteTokens ?? 0,
        ...(options_.withCost && costUsd > 0 ? { costUsd } : {}),
      },
    };
  };

  /**
   * The running token total of the agent steps finished so far. `run_end`
   * reports the same figure for the whole run, so this is only what makes the
   * count move while a multi-step turn is still working — `shell-allow/` spends
   * 26 seconds over three steps before its `run_end`.
   */
  const accumulate = (usage: CmdUsage | undefined): void => {
    turnUsage = {
      inputTokens: (turnUsage.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
      outputTokens: (turnUsage.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
      cacheReadTokens: (turnUsage.cacheReadTokens ?? 0) + (usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: (turnUsage.cacheWriteTokens ?? 0) + (usage?.cacheWriteTokens ?? 0),
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
      forgetRun();
      return [];
    }
    if (id !== undefined) {
      sessionId = id;
    }
    announced = true;
    turnOpen = true;
    forgetRun();
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
    // Only the whole text is a handle the transcript matches on: a shorter
    // prefix is a stale key that both retains its string and answers a later
    // lookup for text that happens to equal it.
    if (known !== undefined) {
      streamedItemForText.delete(known);
    }
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
        // One process is one user turn (spec section 8 step 5). The harness's
        // own `turn_start` counts agent steps inside it.
        return [...onRunStart(event), { type: "turn.started", payload: { turnId: makeTurnId() } }];
      }
      case "turn_start": {
        turnOpen = true;
        deltaRun += 1;
        return [];
      }
      case "turn_end": {
        // The step's tokens. `model_request_end` reports the same numbers one
        // frame earlier, so only one of the two may be counted.
        accumulate(event.usage as CmdUsage | undefined);
        return [usageUpdated(turnUsage, { withCost: false })];
      }
      case "message_start":
      case "message_update":
      case "model_trace":
      case "thinking_start":
      case "notice": {
        // Recognized and deliberately silent. `message_update` re-sends the
        // whole message on every delta — the deltas already stream it and
        // `message_end` closes it — and `thinking_start` carries nothing the
        // first `thinking_delta` does not open.
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
      case "model_request_end": {
        // Usage is `turn_end`'s to report (counting both would double the
        // turn); the model is worth taking, because a run that switched models
        // says so here as well.
        if (event.model !== undefined && event.model !== model) {
          model = event.model;
          return [{ type: "model.changed", payload: { model: event.model } }];
        }
        return [];
      }
      case "message_end": {
        // The finished message. Its text and thinking blocks settle the rows
        // the deltas opened — without this the timeline waits for the
        // transcript, a whole model round trip later. Tool calls in it are the
        // same ones `tool_queued` announces, and dedupe on `toolCallId`.
        return [...onMessageContent(event.content)];
      }
      case "thinking_end": {
        const text = asOptionalString(event.text);
        if (text === undefined) {
          return [];
        }
        const itemId = streamedItemForText.get(text) ?? itemIdFor(`thinking_end:${deltaRun}`);
        return [
          {
            itemId,
            type: "item.completed",
            payload: { item: { itemId, kind: "reasoning", status: "completed", text } },
          },
        ];
      }
      case "tool_queued": {
        // Where a tool call's input lives: `tool_running` announces neither
        // input nor description.
        return [...toolRows.started(event.toolCallId, event.toolName ?? "unknown", event.input)];
      }
      case "tool_running": {
        return [
          ...toolRows.started(
            event.toolCallId,
            event.toolName ?? "unknown",
            undefined,
            asOptionalString(event.description),
          ),
        ];
      }
      case "tool_update": {
        // A long-running tool streaming its output as it goes.
        return [
          ...toolRows.progressed(
            event.toolCallId,
            asString(event.partial) ?? textOfToolResult(event.partial),
          ),
        ];
      }
      case "tool_completed": {
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            truncateToolOutput(textOfToolResult(event.result)),
            false,
          ),
        ];
      }
      case "tool_hooks": {
        // The hook's own verdict, one frame before `tool_hook_blocked`. Only a
        // block is news: an allow outcome means the call is about to run, which
        // the lifecycle frames already say.
        const outcome = asRecord(event.outcome);
        if (outcome.kind !== "block") {
          return [];
        }
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            asString(outcome.text) ?? "blocked by a hook",
            true,
          ),
        ];
      }
      case "tool_hook_blocked": {
        // Either the user's decision coming back through our PreToolUse hook,
        // or the CLI's own ladder refusing outright — `shell-allow/` shows the
        // second: without `--yolo`, print mode declines a shell call the hook
        // already allowed. Both read as a failed row carrying the reason.
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            asString(event.hookOutput) ?? "blocked by a hook",
            true,
          ),
        ];
      }
      // A delegated subagent: three frames of progress on the `task` row the
      // `agent` call opened, and the only trace of work no hook ever sees
      // (`subagents.ts`).
      case "subagent_start":
      case "subagent_progress":
      case "subagent_stop": {
        return [...toolRows.progressed(event.toolCallId, subagentProgress(event) ?? "")];
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
        out.push(usageUpdated(result.usage ?? turnUsage, { withCost: true }));
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
      let priced = false;
      if (typeof cost === "number" && cost > 0 && costKey !== undefined) {
        // A resumed tailer can re-read a line it already costed; the id keeps
        // the turn's total honest.
        if (!costedLines.has(costKey)) {
          costedLines.add(costKey);
          turnCostUsd += cost;
          priced = true;
        }
      }
      // The newest message seen is the resume marker: meta.messageId when the
      // harness names it, else the transcript line's own id.
      lastMessageId = record.message.meta?.messageId ?? record.id ?? lastMessageId;
      const out = [...processMessage(record.message)];
      if (priced) {
        // The transcript is the only source of a dollar figure, and its last
        // flush lands with or after `run_end` — so the price is reported when
        // it arrives rather than only at a turn boundary that may already have
        // passed. `costedLines` is what keeps a re-read line from charging
        // twice.
        out.push(usageUpdated(turnUsage, { withCost: true }));
      }
      return out;
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
