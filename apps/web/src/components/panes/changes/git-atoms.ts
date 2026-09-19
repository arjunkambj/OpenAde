/**
 * The changes pane's git atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the two git atoms on
 * top of it the same way `@/lib/app-runtime` adds the settings ones, so the
 * pane shares one WebSocket with the rest of the app instead of opening a
 * second connection.
 */

import { makeGitAtoms, type GitAtoms } from "@OpenAde/client-runtime/gitAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let gitAtoms: GitAtoms | null = null;

export const useGitAtoms = (): GitAtoms => {
  gitAtoms ??= makeGitAtoms(getAppAtoms().runtime);
  return gitAtoms;
};
