/**
 * The pane's discovery atoms, built once on the app's own `AtomRuntime` the
 * way the changes pane builds its git atoms, so they share the one socket.
 */

import { makeBrowserAtoms, type BrowserAtoms } from "@OpenAde/client-runtime/browserAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let browserAtoms: BrowserAtoms | null = null;

export const useBrowserAtoms = (): BrowserAtoms => {
  browserAtoms ??= makeBrowserAtoms(getAppAtoms().runtime);
  return browserAtoms;
};
