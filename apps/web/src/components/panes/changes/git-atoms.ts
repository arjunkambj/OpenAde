/**
 * The app's git atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the git reads (the
 * Changes pane's) and the git writes (the start screen's worktree steps, the
 * header's branch picker and git actions) on top of it the same way
 * `@/lib/app-runtime` adds the settings ones, so they share one WebSocket with
 * the rest of the app instead of opening a second connection.
 *
 * The writes are one-shot calls on the app's registry, not atoms a component
 * mounts: `useGitCommands` and `useBranchWrites` bind them to the registry in
 * context, and each call resolves with its own `Exit` even when another call
 * is in flight or the component that started it is gone.
 */

import { RegistryContext } from "@effect/atom-react";
import { makeGitAtoms, type GitAtoms } from "@OpenAde/client-runtime/gitAtoms";
import { makeGitCommands, type GitCommands } from "@OpenAde/client-runtime/gitCommands";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

let gitAtoms: GitAtoms | null = null;
let gitCommands: GitCommands | null = null;

const getGitAtoms = (): GitAtoms => {
  gitAtoms ??= makeGitAtoms(getAppAtoms().runtime);
  return gitAtoms;
};

const getGitCommands = (): GitCommands => {
  gitCommands ??= makeGitCommands(getAppAtoms().runtime, getGitAtoms());
  return gitCommands;
};

export const useGitAtoms = (): GitAtoms => getGitAtoms();

/** The branch picker's writes, bound to the app's registry. */
export const useBranchWrites = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const git = getGitAtoms();
    return {
      checkout: (input: Parameters<GitAtoms["checkout"]>[1]) => git.checkout(registry, input),
      createBranch: (input: Parameters<GitAtoms["createBranch"]>[1]) =>
        git.createBranch(registry, input),
    };
  }, [registry]);
};

/** The worktree and commit writes, bound to the app's registry; the setup stays an atom. */
export const useGitCommands = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const commands = getGitCommands();
    return {
      worktreeSetupAtom: commands.worktreeSetupAtom,
      worktreeCreate: (input: Parameters<GitCommands["worktreeCreate"]>[1]) =>
        commands.worktreeCreate(registry, input),
      worktreeRemove: (input: Parameters<GitCommands["worktreeRemove"]>[1]) =>
        commands.worktreeRemove(registry, input),
      commit: (input: Parameters<GitCommands["commit"]>[1]) => commands.commit(registry, input),
      push: (input: Parameters<GitCommands["push"]>[1]) => commands.push(registry, input),
      openPullRequest: (input: Parameters<GitCommands["openPullRequest"]>[1]) =>
        commands.openPullRequest(registry, input),
    };
  }, [registry]);
};
