/**
 * When a turn that was steered is really over.
 *
 * A steered message is one more user message written to the CLI's stdin
 * while a turn runs (`session.ts`, `steer`). The CLI puts it on its command
 * queue and takes it one of two ways:
 *
 * - **folded** into the running turn: between two requests of the agent loop
 *   the CLI drains queued prompts into the conversation, and the turn's one
 *   `result` answers both messages;
 * - **run next**: the running turn ended before the CLI reached a point it
 *   folds at, so the steered message starts a turn of the CLI's own, with a
 *   `result` of its own.
 *
 * Counting `result`s cannot tell those apart. What can is the CLI's
 * `command_lifecycle` receipts, which name every user message by the uuid the
 * session gave it: `queued` when it arrives, `started` when it drains into a
 * turn — folded or fresh — and then one terminal state (`completed`,
 * `cancelled`, `discarded`, `refused`). A folded message is `started` before
 * the running turn's `result`; one that runs next is not. So OpenAde's turn
 * is over at a `result` only once every message steered into it has been
 * `started` or has ended: before that, a `result` closes one of the CLI's
 * turns and OpenAde's goes on to the next. `fixtures/claude/signed-out-steer/`
 * is the run-next path recorded.
 *
 * The receipts are the CLI's `msg_lifecycle_v1` capability. A CLI that never
 * sends one leaves `reporting` false, and a `result` ends the turn as it did
 * before steering existed.
 */

import type { TurnUsage } from "@OpenAde/contracts/orchestration";

import { asRecord, asString } from "./translate/pending";

/** The lifecycle state that says a command has not reached a turn yet. */
const QUEUED = "queued";

export interface SteerLedger {
  /** Reads one SDK message; only `command_lifecycle` receipts count. */
  readonly observe: (message: unknown) => void;
  /** A steered message the running turn has to answer before it ends. */
  readonly watch: (uuid: string) => void;
  /** True while a steered message has neither reached a turn nor ended. */
  readonly awaiting: () => boolean;
  /** The turn ended: nothing more is waited on. */
  readonly clear: () => void;
}

export const makeSteerLedger = (): SteerLedger => {
  const pending = new Set<string>();
  let reporting = false;
  return {
    observe: (message) => {
      const record = asRecord(message);
      if (record.type !== "command_lifecycle") return;
      reporting = true;
      const uuid = asString(record.command_uuid);
      if (uuid !== undefined && record.state !== QUEUED) pending.delete(uuid);
    },
    watch: (uuid) => {
      pending.add(uuid);
    },
    awaiting: () => reporting && pending.size > 0,
    clear: () => {
      pending.clear();
    },
  };
};

/**
 * A turn's usage across the CLI's `result`s. Each `result` reports its own
 * CLI turn's tokens and price; a steered message that ran next makes two of
 * them one OpenAde turn, whose usage is their sum.
 */
export const addUsage = (carried: TurnUsage | null, next: TurnUsage): TurnUsage => {
  if (carried === null) return next;
  const costUsd =
    carried.costUsd === undefined && next.costUsd === undefined
      ? undefined
      : (carried.costUsd ?? 0) + (next.costUsd ?? 0);
  return {
    input: carried.input + next.input,
    output: carried.output + next.output,
    cacheRead: carried.cacheRead + next.cacheRead,
    cacheWrite: carried.cacheWrite + next.cacheWrite,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
};
