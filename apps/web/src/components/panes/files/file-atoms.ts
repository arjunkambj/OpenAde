/**
 * The files pane's atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the two file atoms
 * on top of it the same way `./changes/git-atoms` adds the git ones, so the
 * pane shares one WebSocket with the rest of the app instead of opening a
 * second connection.
 */

import { makeFileAtoms, type FileAtoms } from "@OpenAde/client-runtime/fileAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let fileAtoms: FileAtoms | null = null;

export const useFileAtoms = (): FileAtoms => {
  fileAtoms ??= makeFileAtoms(getAppAtoms().runtime);
  return fileAtoms;
};
