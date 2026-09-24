/**
 * How many of an owner's terminals are still running, and how to say so —
 * the pure half of the project's running-terminals badge
 * (`./project-terminals-badge`).
 */

import type { TerminalListQuery } from "@poseidon/client-runtime/terminalAtoms";

/** The running terminals in a listing; none while it has not answered or failed. */
export const runningTerminalCount = (list: TerminalListQuery | null): number =>
  list?._tag === "ok"
    ? list.terminals.filter((terminal) => terminal.status === "running").length
    : 0;

/** What the badge's tooltip and accessible name say. */
export const runningTerminalsLabel = (count: number): string =>
  `${count} ${count === 1 ? "terminal" : "terminals"} running in this project's folder`;
