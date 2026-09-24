/**
 * The timeline fixture's Stream toggle, as events: each tick upserts the
 * running turn's in-progress assistant message with a few more words of
 * `STREAM_TEXT`, the way a connector's text deltas reach the thread — one
 * `thread.item.upserted` per coalesced delta, the whole text so far each time.
 */

import { makeItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import { STREAM_TEXT, streamedText } from "@/components/dev/timeline-fixture-text";
import type { FixtureClient } from "@/lib/fixture-client";

/** The message a Stream tick is growing: the running turn's last row, while it is in progress. */
const streamingMessage = (fixture: FixtureClient): ItemSnapshot | undefined => {
  const doc = fixture.doc();
  const last = doc.items.at(-1);
  return last !== undefined &&
    last.kind === "assistant_message" &&
    last.status === "in_progress" &&
    doc.currentTurnId !== null &&
    last.turnId === doc.currentTurnId
    ? last
    : undefined;
};

/**
 * One tick: start a turn if none runs, then grow the streaming message or
 * open a new one. Returns false once the whole text is out and the message
 * has settled.
 */
export const streamTick = (fixture: FixtureClient): boolean => {
  const turnId = fixture.startTurn();
  const message = streamingMessage(fixture);
  const text = streamedText(message?.text ?? "");
  const finished = text === STREAM_TEXT;
  fixture.emit("thread.item.upserted", {
    turnId,
    item: {
      itemId: message?.itemId ?? makeItemId(),
      kind: "assistant_message",
      status: finished ? "completed" : "in_progress",
      turnId,
      text,
    },
  });
  return !finished;
};

/** Stop streaming: the message in flight, if any, settles with what it has. */
export const settleStream = (fixture: FixtureClient): void => {
  const message = streamingMessage(fixture);
  if (message === undefined || message.turnId === undefined) {
    return;
  }
  fixture.emit("thread.item.upserted", {
    turnId: message.turnId,
    item: { ...message, status: "completed" },
  });
};
