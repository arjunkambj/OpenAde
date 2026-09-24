/**
 * Which timeline row a piece of assistant text belongs on.
 *
 * Three sources describe the same message and they have to land on one row:
 * `text_delta`/`thinking_delta` frames as it streams, the `message_end` frame
 * that finishes it, and the transcript line (or `run_end` reconcile) that
 * replays it a model round trip later. `makeToolRows` in `items.ts` does the
 * same job for tool calls, where `tool_use.id` is a handle every source
 * carries. Text has no such handle: the real CLI's deltas are anonymous —
 * `{"type":"text_delta","delta":"ok"}`, no message id, no index — so the only
 * thing the frames and the transcript share is the text itself.
 *
 * Text is not unique, though. One message may repeat a block, and two agent
 * steps may both end in "Done.". A plain text → row index answered every one of
 * those with the first row, so a second block silently settled a row another
 * block already owned. So:
 *
 * - a row that streamed its text is found by that text, once per source;
 * - a row a `message_end` had to mint itself queues per text, and the replay
 *   takes them back one block at a time, in the order they were minted;
 * - `claimed` is the set of rows the message being folded has already settled,
 *   and a lookup will not hand back one of those.
 */

import { makeItemId, type ItemId } from "@poseidon/contracts/ids";

/** A row a delta opened and nothing has settled yet. */
export interface OpenTextRow {
  readonly itemId: ItemId;
  readonly kind: "assistant_message" | "reasoning";
  /** Everything streamed onto it so far. */
  readonly text: string;
}

export interface TextRows {
  /** The row for a key, minted once and remembered for the session. */
  readonly idFor: (key: string) => ItemId;
  /** The row that streamed exactly this text, if one did. */
  readonly streamedFor: (text: string) => ItemId | undefined;
  /**
   * One delta folded into its row, which also registers the text built up so
   * far as that row's handle. `opened` is true on the first delta, which is
   * where the caller opens the row.
   */
  readonly delta: (
    key: string,
    text: string,
    kind: OpenTextRow["kind"],
  ) => { readonly itemId: ItemId; readonly opened: boolean };
  /** This row has been completed — it is no longer one of the open ones. */
  readonly settle: (itemId: ItemId) => void;
  /**
   * Rows still streaming. A SIGINT'd run writes no `message_end` and no
   * `run_end`, so without this the last row it opened stayed `in_progress`
   * forever — a spinner under an idle thread, still spinning after a reload.
   */
  readonly open: () => ReadonlyArray<OpenTextRow>;
  /** Counts `message_end` frames; part of the keys the next call mints. */
  readonly nextMessage: () => number;
  /** The row a `message_end` block settles, minting and queueing if need be. */
  readonly ended: (text: string, message: number, index: number, claimed: Set<ItemId>) => ItemId;
  /** The row a replayed transcript/`nextState` block settles. */
  readonly replayed: (text: string, key: string, claimed: Set<ItemId>) => ItemId;
  /**
   * Drops the per-run accumulation. Only the partial text goes: the reverse
   * indexes live as long as the session, because a transcript line arriving
   * after `run_end` still has to find the row it already streamed on.
   */
  readonly forgetRun: () => void;
}

export const makeTextRows = (): TextRows => {
  /** `${messageId}:${blockIndex}` (or a minted key) → itemId. */
  const blockItems = new Map<string, ItemId>();
  /** The text accumulated so far on each streamed row, by delta key. */
  const streamedText = new Map<string, string>();
  /** The reverse index: whole streamed text → the row that streamed it. */
  const streamedItemForText = new Map<string, ItemId>();
  /** Rows a `message_end` minted itself, in mint order, per text. */
  const endedItemsForText = new Map<string, Array<ItemId>>();
  /** Rows a delta opened and nothing has settled yet. */
  const openRows = new Map<ItemId, OpenTextRow>();
  let endedMessages = 0;

  const idFor = (key: string): ItemId => {
    const existing = blockItems.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const itemId = makeItemId();
    blockItems.set(key, itemId);
    return itemId;
  };

  const rememberEnded = (text: string, itemId: ItemId): void => {
    const queue = endedItemsForText.get(text);
    if (queue === undefined) {
      endedItemsForText.set(text, [itemId]);
      return;
    }
    queue.push(itemId);
  };

  const takeEnded = (text: string): ItemId | undefined => {
    const queue = endedItemsForText.get(text);
    if (queue === undefined) {
      return undefined;
    }
    const itemId = queue.shift();
    if (queue.length === 0) {
      endedItemsForText.delete(text);
    }
    return itemId;
  };

  return {
    idFor,
    streamedFor: (text) => streamedItemForText.get(text),
    delta: (key, text, kind) => {
      const known = streamedText.get(key);
      const itemId = idFor(key);
      const full = (known ?? "") + text;
      streamedText.set(key, full);
      openRows.set(itemId, { itemId, kind, text: full });
      // Only the whole text is a handle the transcript matches on: a shorter
      // prefix is a stale key that both retains its string and answers a later
      // lookup for text that happens to equal it.
      if (known !== undefined) {
        streamedItemForText.delete(known);
      }
      streamedItemForText.set(full, itemId);
      return { itemId, opened: known === undefined };
    },
    settle: (itemId) => {
      openRows.delete(itemId);
    },
    open: () => [...openRows.values()],
    nextMessage: () => {
      endedMessages += 1;
      return endedMessages;
    },
    ended: (text, message, index, claimed) => {
      const streamed = streamedItemForText.get(text);
      // The key counts messages rather than agent steps, so two `message_end`
      // frames inside one step cannot share a row either.
      const itemId =
        streamed !== undefined && !claimed.has(streamed)
          ? streamed
          : idFor(`message_end:${message}:${index}`);
      claimed.add(itemId);
      if (itemId !== streamed) {
        rememberEnded(text, itemId);
      }
      return itemId;
    },
    replayed: (text, key, claimed) => {
      const streamed = streamedItemForText.get(text);
      const itemId =
        streamed !== undefined && !claimed.has(streamed)
          ? streamed
          : (takeEnded(text) ?? idFor(key));
      claimed.add(itemId);
      return itemId;
    },
    forgetRun: () => {
      streamedText.clear();
    },
  };
};
