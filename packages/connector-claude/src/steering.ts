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
 * the running turn's `result`; one that runs next is not. So Poseidon's turn
 * is over at a `result` only once every message steered into it has been
 * `started` or has ended: before that, a `result` closes one of the CLI's
 * turns and Poseidon's goes on to the next. `fixtures/claude/signed-out-steer/`
 * is the run-next path recorded.
 *
 * A held turn can also end with no `result` at all: a steered message that
 * reaches an end state without ever being `started` — cancelled by Stop's
 * `cancelQueued` in the moment between two of the CLI's turns — starts no
 * turn of the CLI's, so no `result` will close Poseidon's. `observe` says so
 * (`dropped`), and the session ends the held turn there.
 *
 * The receipts are the CLI's `msg_lifecycle_v1` capability, which its
 * `system/init` lists. Without them a steered message that runs next would
 * run as a turn nobody opened, and its `result` would close the one after it;
 * so a steer is taken only once the CLI has shown it sends them (`receipts`),
 * and refused — for the caller to queue — on a CLI that does not, or before
 * the CLI has said either way.
 */

import type { TurnUsage } from "@poseidon/contracts/orchestration";

import { asRecord, asString } from "./translate/pending";

/** The lifecycle state that says a command has not reached a turn yet. */
const QUEUED = "queued";
/** The lifecycle state that says a command reached a turn, folded or fresh. */
const STARTED = "started";
/** The `system/init` capability that says the CLI sends the receipts. */
const LIFECYCLE_CAPABILITY = "msg_lifecycle_v1";

/**
 * What a receipt did to a watched message: it reached a turn, or it ended
 * without ever reaching one.
 */
export type SteerReceipt = "started" | "dropped";

export interface SteerLedger {
  /**
   * Reads one SDK message; only `system/init` and `command_lifecycle` count.
   * Says what became of a watched message when the message was its receipt.
   */
  readonly observe: (message: unknown) => SteerReceipt | null;
  /** A steered message the running turn has to answer before it ends. */
  readonly watch: (uuid: string) => void;
  /** True while a steered message has neither reached a turn nor ended. */
  readonly awaiting: () => boolean;
  /**
   * Whether the CLI sends receipts: true once it showed it does, false once
   * its `system/init` showed it does not, undefined before either.
   */
  readonly receipts: () => boolean | undefined;
  /** The turn ended: nothing more is waited on. */
  readonly clear: () => void;
}

export const makeSteerLedger = (): SteerLedger => {
  const pending = new Set<string>();
  let receipts: boolean | undefined;
  return {
    observe: (message) => {
      const record = asRecord(message);
      if (record.type === "system" && record.subtype === "init" && receipts !== true) {
        receipts =
          Array.isArray(record.capabilities) && record.capabilities.includes(LIFECYCLE_CAPABILITY);
        return null;
      }
      if (record.type !== "command_lifecycle") return null;
      receipts = true;
      const uuid = asString(record.command_uuid);
      if (uuid === undefined || record.state === QUEUED || !pending.delete(uuid)) return null;
      return record.state === STARTED ? "started" : "dropped";
    },
    watch: (uuid) => {
      pending.add(uuid);
    },
    awaiting: () => receipts === true && pending.size > 0,
    receipts: () => receipts,
    clear: () => {
      pending.clear();
    },
  };
};

/**
 * A turn's usage across the CLI's `result`s. Each `result` reports its own
 * CLI turn's tokens and price; a steered message that ran next makes two of
 * them one Poseidon turn, whose usage is their sum.
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
