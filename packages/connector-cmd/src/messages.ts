/**
 * Folding a whole message into timeline rows.
 *
 * Two sources describe the same message and both land here: the `message_end`
 * frame that finishes it live, and the transcript line — or the `run_end`
 * reconcile of `nextState.messages` — that replays it a model round trip
 * later. They share every dedupe key, so the second lands on the rows the
 * first opened instead of a second set beside them: text and thinking find
 * their row through the text the deltas streamed, tool calls key on
 * `tool_use.id`, and a whole message keys on `meta.messageId`.
 *
 * Split out of `translate.ts`, which has a file-size budget and a different
 * job: reading one frame at a time.
 */

import type { ItemId } from "@OpenAde/contracts/ids";

import {
  anonymousKey,
  asOptionalString,
  asRecord,
  asString,
  type PendingRuntimeEvent,
  type ToolResultBlock,
  type ToolUseBlock,
  type ToolRows,
  type TranscriptMessage,
} from "./items";
import type { TextRows } from "./textRows";

export interface MessageFolder {
  /** One transcript/nextState message → its items, once per message. */
  readonly processMessage: (message: TranscriptMessage) => ReadonlyArray<PendingRuntimeEvent>;
  /** The content blocks of a `message_end` frame → the events that settle them. */
  readonly onMessageContent: (content: unknown) => ReadonlyArray<PendingRuntimeEvent>;
}

export const makeMessageFolder = (deps: {
  readonly toolRows: ToolRows;
  readonly textRows: TextRows;
  readonly unmapped: (source: string, payload: unknown) => PendingRuntimeEvent;
}): MessageFolder => {
  const { toolRows, textRows, unmapped } = deps;
  /** meta.messageId — or content-hash key — of every message already folded. */
  const seenMessages = new Set<string>();

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
    /** Rows this message has already settled — one block may not take two. */
    const claimed = new Set<ItemId>();

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
          // open a second one next to it. A row this same message already
          // settled is not that row, though: take the next one instead.
          const itemId = textRows.replayed(text, key, claimed);
          textRows.settle(itemId);
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
          const itemId = textRows.replayed(thinking, key, claimed);
          textRows.settle(itemId);
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
    const message = textRows.nextMessage();
    /** Rows this frame has already settled — one block may not take two. */
    const claimed = new Set<ItemId>();
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
          // A model that streams no deltas still gets a row: `ended` mints one
          // and queues it so the transcript recognizes it as already emitted.
          const itemId = textRows.ended(text, message, index, claimed);
          textRows.settle(itemId);
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

  return { processMessage, onMessageContent };
};
