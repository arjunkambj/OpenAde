/**
 * A streaming frame → `content.delta` on the row its message will finish on.
 *
 * This was written for delta frames before one had been captured, so it reads
 * every spelling the family uses (`delta.text`, `delta.thinking`,
 * `delta.partial_json`, a bare `text`) off any `*_delta` event, and returns
 * null for anything it cannot read so the frame still surfaces as
 * `event.unmapped` rather than disappearing.
 *
 * Keying is what keeps the later full block from opening a second row. A frame
 * that names its message uses `${messageId}:${index}` — exactly the key the
 * transcript fold mints — and an anonymous one is recognized by the text it
 * accumulated, which the fold looks up before minting.
 */

import type { ContentDeltaKind } from "@OpenAde/contracts/runtime";

import { asRecord, asString, type PendingRuntimeEvent } from "./items";
import type { TextRows } from "./textRows";

export const deltaEvents = (
  event: { readonly type: string; readonly [key: string]: unknown },
  textRows: TextRows,
  /** Bumped on every `turn_start`, so two agent steps cannot share a key. */
  deltaRun: number,
): ReadonlyArray<PendingRuntimeEvent> | null => {
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
  // The anonymous key carries the kind. An agent step streams `thinking_delta*`
  // and then `text_delta*` with neither a message id nor an index
  // (`fixtures/cmd/resume/turn2`), so a kind-less key put the answer on the row
  // the thinking opened: `textRows.delta` re-registered that row under
  // "<thinking><answer>", the `message_end` thinking block could no longer find
  // the row it had streamed on, and it minted a second reasoning row beside the
  // first. Same shape in mcp, shell-twice/turn2, question-tools, plan-write,
  // plan-no-yolo and shell-deny.
  const key =
    typeof messageId === "string" ? `${messageId}:${index}` : `delta:${deltaRun}:${kind}:${index}`;
  const rowKind = kind === "reasoning" ? ("reasoning" as const) : ("assistant_message" as const);
  const { itemId, opened } = textRows.delta(key, text, rowKind);
  const out: Array<PendingRuntimeEvent> = [];
  if (opened) {
    out.push({
      itemId,
      type: "item.started",
      payload: { item: { itemId, kind: rowKind, status: "in_progress" } },
    });
  }
  out.push({ itemId, type: "content.delta", payload: { itemId, kind, delta: text } });
  return out;
};
