/**
 * The New task hand-over as a sequence of steps, the pure half of
 * `./use-terminal-hand-over`: what the client does around `terminal.adopt`,
 * and in which order, so no step can leave the page's drawer open with
 * nothing in it.
 *
 * An open drawer whose listing says it has no terminals starts one (see
 * `./terminal-drawer`). Once the server has moved the project's shells, the
 * project's listing is empty — and that listing can arrive at any moment: a
 * refetch answered after the move but before adopt's reply, or a reconnect
 * after the socket dropped with the reply in flight. So:
 *
 * 1. The project's drawer is closed before adopt is called, having noted
 *    whether it was open and which terminals the client knows the project
 *    has. A closed drawer starts nothing, whatever its listing says.
 * 2. adopt answers what moved. Only when something did does the client state
 *    follow (`moveState`): the tabs and the one in front, and an open drawer,
 *    go to the thread.
 * 3. A failed adopt — refused, or a reply lost with the socket — may still
 *    have moved the shells, so the thread's listing decides: if it now holds
 *    terminals the project had (any at all, when the client knew of none), the
 *    state moves as if adopt had answered. If the thread holds none of them,
 *    the shells stayed the project's, and a drawer that was open on them opens
 *    again. If the listing cannot be had either, nothing more happens: the
 *    project's drawer stays closed, and the thread's drawer lists whatever the
 *    server gave it when it is opened.
 */

import type { TerminalId } from "@OpenAde/contracts/ids";

export interface HandOverSteps {
  /** Whether the project's drawer is open, and the terminals the client knows it has. */
  readonly before: () => { readonly open: boolean; readonly ids: ReadonlyArray<TerminalId> };
  readonly closeProjectDrawer: () => void;
  /** `terminal.adopt`: the ids it moved, or `null` when it failed or its reply was lost. */
  readonly adopt: () => Promise<ReadonlyArray<TerminalId> | null>;
  /** The thread's terminals as the server lists them now, or `null` when it cannot say. */
  readonly listThread: () => Promise<ReadonlyArray<TerminalId> | null>;
  /** Moves the tabs to the thread, and opens its drawer when `open`. */
  readonly moveState: (open: boolean) => void;
  readonly reopenProjectDrawer: () => void;
}

/** What happened to the shells, as far as the client could tell. */
export type HandOverOutcome = "moved" | "kept" | "unknown";

export const runHandOver = async (steps: HandOverSteps): Promise<HandOverOutcome> => {
  const { open, ids } = steps.before();
  if (open) {
    steps.closeProjectDrawer();
  }
  const adopted = await steps.adopt();
  let moved: boolean;
  if (adopted !== null) {
    moved = adopted.length > 0;
  } else {
    const listed = await steps.listThread();
    if (listed === null) {
      return "unknown";
    }
    moved = listed.some((terminalId) => ids.length === 0 || ids.includes(terminalId));
  }
  if (moved) {
    steps.moveState(open);
    return "moved";
  }
  // The shells stayed the project's: an open drawer shows them again. With
  // none known there is nothing to show, and reopening would start one.
  if (open && ids.length > 0) {
    steps.reopenProjectDrawer();
  }
  return "kept";
};
