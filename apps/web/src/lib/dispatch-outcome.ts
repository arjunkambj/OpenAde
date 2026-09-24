/**
 * Reading the outcome of a `dispatchAtom` call, in one place.
 *
 * A dispatch has two failure shapes and they mean different things. A decider
 * that *refused* the command answers with a `CommandReceipt` carrying
 * `status: "rejected"` and usually a reason — the server heard it and said no.
 * A dropped socket, an `PoseidonRpcError` or a decode failure produces no
 * receipt at all — nobody heard it, and trying again may well work. Every call
 * site needs both arms, and clearing whatever pending flag it set in both is
 * what keeps an interaction card answerable after a failed attempt instead of
 * wedging it with every button disabled.
 *
 * Which pair to use depends only on how the caller consumed the atom, and
 * both consumers exist on purpose:
 *
 *  - `mode: "promise"` *rejects* on a transport failure, so those callers pair
 *    `receiptError` with `DISPATCH_UNREACHABLE` in the rejection handler.
 *  - `mode: "promiseExit"` never throws, so those callers read one `Exit` with
 *    `isAccepted` / `rejectionMessage`.
 *
 * The two wordings for "nobody answered" are deliberate, not a duplicate: the
 * inline error strips render a lowercase fragment after a label, the toasts
 * render a standalone sentence.
 */

import type { CommandReceipt } from "@poseidon/contracts/orchestration";
import * as Exit from "effect/Exit";

/** Shown when the dispatch promise rejected — the server never answered. */
export const DISPATCH_UNREACHABLE = "could not reach the server — try again";

/** The same condition, as a standalone sentence for a toast. */
const UNREACHABLE_SENTENCE = "Could not reach the server";

/** The error line for a receipt, or null when the command was accepted. */
export const receiptError = (receipt: CommandReceipt, fallback: string): string | null =>
  receipt.status === "rejected" ? (receipt.reason ?? fallback) : null;

export type DispatchExit = Exit.Exit<CommandReceipt, unknown>;

/** The command reached the server and the decider took it. */
export const isAccepted = (exit: DispatchExit): boolean =>
  Exit.isSuccess(exit) && exit.value.status === "accepted";

/**
 * What to tell the user when `isAccepted` is false: the server's own reason
 * when it answered, `fallback` when it answered without one, and the transport
 * sentence when it never answered at all.
 */
export const rejectionMessage = (exit: DispatchExit, fallback: string): string =>
  Exit.isSuccess(exit) ? (exit.value.reason ?? fallback) : UNREACHABLE_SENTENCE;
