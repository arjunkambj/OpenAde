/**
 * The terminal drawer's atoms, built once on the app's own `AtomRuntime`.
 *
 * Like `@/components/panes/changes/git-atoms`, this adds the terminal atoms on
 * top of the single runtime `@/state/app-runtime` owns, so terminals share the
 * one WebSocket with the rest of the app instead of opening a second
 * connection.
 */

import { RegistryContext } from "@effect/atom-react";
import {
  makeTerminalAtoms,
  type TerminalAtoms,
  type TerminalOpenArgs,
} from "@OpenAde/client-runtime/terminalAtoms";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

let terminalAtoms: TerminalAtoms | null = null;

export const useTerminalAtoms = (): TerminalAtoms => {
  terminalAtoms ??= makeTerminalAtoms(getAppAtoms().runtime);
  return terminalAtoms;
};

/** `openTerminal` bound to the app's registry: each call resolves with its own `Exit`. */
export const useOpenTerminal = () => {
  const atoms = useTerminalAtoms();
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (args: TerminalOpenArgs) => atoms.openTerminal(registry, args),
    [atoms, registry],
  );
};
