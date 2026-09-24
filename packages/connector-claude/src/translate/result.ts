/**
 * A `result` message → the turn's usage, its context, and its completion.
 *
 * The SDK writes one `result` per turn. Its fields do not share a lifecycle,
 * and the SDK's own declarations say which is which:
 *
 * - `usage` is the main loop's tokens for this turn alone;
 * - `total_cost_usd` and `modelUsage` are running totals for the process — and
 *   for a resumed session they start from what its transcript saved — so the
 *   turn's price is the difference from the previous result's total, which
 *   the session carries across restarts in its ref. A total lower than the
 *   previous one was reset by a `/clear`, and is the turn's price by itself.
 */

import type { TurnId } from "@poseidon/contracts/ids";
import type { TurnStopReason } from "@poseidon/contracts/runtime";

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  tokens,
  type Json,
  type PendingRuntimeEvent,
} from "./pending";

/** The turn a result closes, as the session knows it. */
export interface TurnContext {
  readonly turnId: TurnId;
  /** The user pressed stop: the result reads `interrupted`, whatever it says. */
  readonly interrupted: boolean;
}

export interface ResultState {
  /**
   * The previous result's `total_cost_usd`: 0 for a fresh session, the ref's
   * saved total for a resumed one, null when a resumed ref saved none.
   */
  readonly previousTotalCost: number | null;
  /** Tokens in the context after the turn's last main-loop request, if known. */
  readonly contextUsed: number | null;
  /** The window those tokens are measured against, if known. */
  readonly contextLimit: number | null;
  /** The model the CLI reported running, to find its row in `modelUsage`. */
  readonly model: string | null;
  /** The turn already reported its error — the result need not say it again. */
  readonly errorReported: boolean;
}

export const stopReasonOf = (message: Json, turn: TurnContext): TurnStopReason => {
  if (turn.interrupted) return "interrupted";
  const subtype = asString(message.subtype);
  if (subtype === "error_max_turns") return "max_turns";
  return subtype === "success" && message.is_error !== true ? "end_turn" : "error";
};

/** The context window `modelUsage` reports for the running model, or its largest. */
const windowOf = (modelUsage: Json, model: string | null): number | null => {
  const exact = model === null ? undefined : asNumber(asRecord(modelUsage[model]).contextWindow);
  if (exact !== undefined && exact > 0) return exact;
  const all = Object.values(modelUsage).flatMap((entry) => {
    const window_ = asNumber(asRecord(entry).contextWindow);
    return window_ === undefined || window_ <= 0 ? [] : [window_];
  });
  return all.length === 0 ? null : Math.max(...all);
};

/** What the result's error says, when the turn failed and nothing said so yet. */
const errorText = (message: Json): string | undefined => {
  const errors = asArray(message.errors).flatMap((entry) =>
    typeof entry === "string" && entry !== "" ? [entry] : [],
  );
  if (errors.length > 0) return errors.join("\n");
  const result = asString(message.result);
  return result === undefined || result === "" ? undefined : result;
};

export const resultEvents = (
  message: Json,
  turn: TurnContext | null,
  state: ResultState,
): { readonly events: ReadonlyArray<PendingRuntimeEvent>; readonly totalCost: number | null } => {
  const events: Array<PendingRuntimeEvent> = [];
  const total = asNumber(message.total_cost_usd) ?? null;
  // Unknown when either end is: a resumed session whose ref never saw a total
  // cannot tell this turn's share of the first one it reads.
  const previous = state.previousTotalCost;
  const cost =
    total === null || previous === null ? undefined : total >= previous ? total - previous : total;

  if (turn !== null) {
    const usage = asRecord(message.usage);
    events.push({
      type: "usage.updated",
      payload: {
        turnId: turn.turnId,
        input: tokens(usage.input_tokens),
        output: tokens(usage.output_tokens),
        cacheRead: tokens(usage.cache_read_input_tokens),
        cacheWrite: tokens(usage.cache_creation_input_tokens),
        ...(cost === undefined ? {} : { costUsd: cost }),
      },
    });
  }

  const limit = state.contextLimit ?? windowOf(asRecord(message.modelUsage), state.model);
  if (state.contextUsed !== null && state.contextUsed > 0 && limit !== null) {
    events.push({
      type: "context.updated",
      payload: { used: Math.trunc(state.contextUsed), limit: Math.trunc(limit) },
    });
  }

  const stopReason = turn === null ? null : stopReasonOf(message, turn);
  if (stopReason === "error" && !state.errorReported) {
    const text = errorText(message);
    if (text !== undefined) {
      events.push({ type: "runtime.error", payload: { message: text, fatal: false } });
    }
  }
  if (turn !== null && stopReason !== null) {
    events.push({ type: "turn.completed", payload: { turnId: turn.turnId, stopReason } });
  }
  return { events, totalCost: total };
};
