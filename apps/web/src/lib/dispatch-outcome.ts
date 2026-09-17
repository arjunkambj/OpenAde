/**
 * What a `dispatchAtom` call turned into, as a line the caller can show.
 *
 * `dispatchAtom` is consumed with `mode: "promise"`, so a dropped socket, an
 * `OpenAdeRpcError` or a decode failure *rejects* — no receipt is ever
 * delivered. Every call site therefore needs two arms: `receiptError` for the
 * receipt it did get, and `DISPATCH_UNREACHABLE` for the rejection. Clearing
 * the pending flag in both is what keeps an interaction card answerable after
 * a failed attempt instead of wedging it with every button disabled.
 */

import type { CommandReceipt } from "@OpenAde/contracts/orchestration";

/** Shown when the dispatch promise rejected — the server never answered. */
export const DISPATCH_UNREACHABLE = "could not reach the server — try again";

/** The error line for a receipt, or null when the command was accepted. */
export const receiptError = (receipt: CommandReceipt, fallback: string): string | null =>
  receipt.status === "rejected" ? (receipt.reason ?? fallback) : null;
