/**
 * Reading a dispatch's `Exit<CommandReceipt, …>` the same way everywhere.
 *
 * `dispatchAtom` in `promiseExit` mode never throws: a transport failure comes
 * back as a failed exit, and a decider that refused the command comes back as
 * a *successful* exit carrying `status: "rejected"`. Those are two different
 * sentences to the user, and every call site was writing them out by hand.
 */

import type { CommandReceipt } from "@OpenAde/contracts/orchestration";
import * as Exit from "effect/Exit";

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
  Exit.isSuccess(exit) ? (exit.value.reason ?? fallback) : "Could not reach the server";
