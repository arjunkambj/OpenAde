/**
 * The file atoms, built once per client runtime.
 *
 * The app has one runtime (`@/state/app-runtime`), so this adds the file atoms
 * on top of it the same way `./changes/git-atoms` adds the git ones, and the
 * Files tab and the timeline's file chips share one WebSocket with the rest of
 * the app instead of opening a second connection. A fixture page substitutes
 * its own runtime through `ClientRuntimeProvider`, and gets file atoms over
 * its scripted client.
 */

import { makeFileAtoms, type FileAtoms } from "@OpenAde/client-runtime/fileAtoms";

import { type ClientRuntime, useClientRuntime } from "@/lib/client-runtime";

const byRuntime = new WeakMap<ClientRuntime["runtime"], FileAtoms>();

export const useFileAtoms = (): FileAtoms => {
  const { runtime } = useClientRuntime();
  let atoms = byRuntime.get(runtime);
  if (atoms === undefined) {
    atoms = makeFileAtoms(runtime);
    byRuntime.set(runtime, atoms);
  }
  return atoms;
};
