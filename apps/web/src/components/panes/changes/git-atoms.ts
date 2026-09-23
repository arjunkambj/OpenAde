/**
 * The app's git atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the git reads (the
 * Changes pane's) and the git writes (the start screen's worktree steps) on
 * top of it the same way `@/lib/app-runtime` adds the settings ones, so they
 * share one WebSocket with the rest of the app instead of opening a second
 * connection.
 */

import { makeGitAtoms, type GitAtoms } from "@OpenAde/client-runtime/gitAtoms";
import { makeGitCommands, type GitCommands } from "@OpenAde/client-runtime/gitCommands";

import { getAppAtoms } from "@/state/app-runtime";

let gitAtoms: GitAtoms | null = null;
let gitCommands: GitCommands | null = null;

const getGitAtoms = (): GitAtoms => {
  gitAtoms ??= makeGitAtoms(getAppAtoms().runtime);
  return gitAtoms;
};

export const useGitAtoms = (): GitAtoms => getGitAtoms();

export const useGitCommands = (): GitCommands => {
  gitCommands ??= makeGitCommands(getAppAtoms().runtime, getGitAtoms());
  return gitCommands;
};
