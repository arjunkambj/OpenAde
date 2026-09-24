/**
 * The CLI compacting its context, as one divider row.
 *
 * A `/compact` turn, or the CLI running out of room by itself, is told twice:
 * a `system/status` of `compacting` while the CLI summarises, then a
 * `system/compact_boundary` once the summary replaced the conversation, with
 * what triggered it and how many tokens it held before and after. The first
 * opens a `context_compaction` row, the second settles it and, when it names
 * the size after, reports the context that is left. A boundary with no status
 * before it opens and settles the row at once.
 *
 * A compaction that fails has no boundary: the status goes back to `null`
 * with `compact_result: "failed"` and the CLI's `compact_error`
 * (`fixtures/claude/session-controls/`, a `/compact` on a CLI that is not
 * signed in), and the row fails with that line. The CLI then says the same
 * line again as the turn's answer.
 *
 * A compaction still open when its turn's result arrives did not finish, and
 * the row is failed there, as a tool row is.
 */

import type { ItemId } from "@poseidon/contracts/ids";
import { makeItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import { asNumber, asRecord, asString, type Json, type PendingRuntimeEvent } from "./pending";

export const COMPACTING = "Compacting context…";

/** Why a compaction failed, when the CLI did not say. */
export const COMPACTION_FAILED = "The context could not be compacted.";

/** Why a compaction row still open at the end of its turn is failed. */
export const COMPACTION_UNFINISHED = "The turn ended before the context was compacted.";

/** The settled row's line: what the context held before and after, when the CLI said. */
export const compactedText = (metadata: Json): string => {
  const before = asNumber(metadata.pre_tokens);
  const after = asNumber(metadata.post_tokens);
  if (before === undefined) return "Context compacted";
  return after === undefined
    ? `Context compacted from ${before.toLocaleString("en-US")} tokens`
    : `Context compacted: ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} tokens`;
};

export interface Compaction {
  /** `system/status: compacting` → the row opens. */
  readonly compacting: () => ReadonlyArray<PendingRuntimeEvent>;
  /**
   * `system/compact_boundary` → the row settles; `contextLimit` is the window
   * the size after is reported against, when the translator knows it.
   */
  readonly boundary: (
    message: Json,
    contextLimit: number | null,
  ) => {
    readonly events: ReadonlyArray<PendingRuntimeEvent>;
    /** Tokens in the context now, when the CLI said. */
    readonly contextUsed: number | undefined;
  };
  /**
   * `system/status` back to `null` → a compaction that failed fails its row;
   * one that did not fail is settled by its boundary.
   */
  readonly statusCleared: (message: Json) => ReadonlyArray<PendingRuntimeEvent>;
  /** The turn ended: a row still open is failed. */
  readonly abandon: () => ReadonlyArray<PendingRuntimeEvent>;
}

const upsert = (
  type: "item.started" | "item.completed",
  item: ItemSnapshot,
): PendingRuntimeEvent => ({ itemId: item.itemId, type, payload: { item } });

export const makeCompaction = (): Compaction => {
  let open: ItemId | null = null;

  const fail = (reason: string): ReadonlyArray<PendingRuntimeEvent> => {
    const itemId = open ?? makeItemId();
    open = null;
    return [
      upsert("item.completed", {
        itemId,
        kind: "context_compaction",
        status: "failed",
        text: "Context not compacted",
        error: { message: reason },
      }),
    ];
  };

  return {
    compacting: () => {
      if (open !== null) return [];
      open = makeItemId();
      return [
        upsert("item.started", {
          itemId: open,
          kind: "context_compaction",
          status: "in_progress",
          text: COMPACTING,
        }),
      ];
    },
    boundary: (message, contextLimit) => {
      const itemId = open ?? makeItemId();
      open = null;
      const metadata = asRecord(message.compact_metadata);
      const after = asNumber(metadata.post_tokens);
      const events: Array<PendingRuntimeEvent> = [
        upsert("item.completed", {
          itemId,
          kind: "context_compaction",
          status: "completed",
          text: compactedText(metadata),
        }),
      ];
      const used = after === undefined ? undefined : Math.max(0, Math.trunc(after));
      if (used !== undefined && contextLimit !== null) {
        events.push({ type: "context.updated", payload: { used, limit: contextLimit } });
      }
      return { events, contextUsed: used };
    },
    statusCleared: (message) => {
      if (open === null || message.compact_result !== "failed") return [];
      return fail(asString(message.compact_error)?.trim() || COMPACTION_FAILED);
    },
    abandon: () => (open === null ? [] : fail(COMPACTION_UNFINISHED)),
  };
};
