/**
 * The folder picker's atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the browse atom on
 * top of it the same way the files pane adds `fileAtoms` and the changes pane
 * adds `gitAtoms`, so the dialog shares one WebSocket with the rest of the app
 * instead of opening a second connection.
 */

import { makeFsAtoms, type FsAtoms } from "@OpenAde/client-runtime/fsAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let fsAtoms: FsAtoms | null = null;

export const useFsAtoms = (): FsAtoms => {
  fsAtoms ??= makeFsAtoms(getAppAtoms().runtime);
  return fsAtoms;
};
