/**
 * The terminal drawer's atoms, built once on the app's own `AtomRuntime`.
 *
 * Like `@/components/panes/changes/git-atoms`, this adds the terminal atoms on
 * top of the single runtime `@/state/app-runtime` owns, so terminals share the
 * one WebSocket with the rest of the app instead of opening a second
 * connection.
 */

import { makeTerminalAtoms, type TerminalAtoms } from "@OpenAde/client-runtime/terminalAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let terminalAtoms: TerminalAtoms | null = null;

export const useTerminalAtoms = (): TerminalAtoms => {
  terminalAtoms ??= makeTerminalAtoms(getAppAtoms().runtime);
  return terminalAtoms;
};
