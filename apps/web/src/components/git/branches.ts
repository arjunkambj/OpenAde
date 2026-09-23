/**
 * The pure half of the branch picker: which branches it lists for a search,
 * whether it offers to create one, and what a refused switch says.
 *
 * A remote branch whose local twin exists is left out — picking
 * `origin/feature` would only switch to the local `feature` anyway (the server
 * switches to the existing local branch of that name), so listing both shows
 * the same choice twice.
 */

import type { GitBranch, GitBranchList } from "@OpenAde/contracts/git";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { isObject, isString } from "effect/Predicate";

export interface BranchGroups {
  readonly local: ReadonlyArray<GitBranch>;
  readonly remote: ReadonlyArray<GitBranch>;
}

/**
 * The branch a remote-tracking ref stands for: `origin/feature/x` is
 * `feature/x`. The longest matching remote wins, so a remote named `a/b`
 * is not read as `a`.
 */
export const remoteShortName = (name: string, remotes: ReadonlyArray<string>): string => {
  const remote = remotes
    .filter((candidate) => name.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0];
  return remote === undefined ? name : name.slice(remote.length + 1);
};

const matches = (name: string, query: string): boolean =>
  query === "" || name.toLowerCase().includes(query.toLowerCase());

/**
 * The picker's two groups for `query`: local branches with the current one
 * first, then remote branches that have no local twin. Matching is a
 * case-insensitive substring of the name, so `feat` finds `openade/feature`.
 */
export const groupBranches = (list: GitBranchList, query: string): BranchGroups => {
  const needle = query.trim();
  const localNames = new Set(
    list.branches.filter((branch) => branch.kind === "local").map((branch) => branch.name),
  );
  const local = list.branches
    .filter((branch) => branch.kind === "local" && matches(branch.name, needle))
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  const remote = list.branches.filter(
    (branch) =>
      branch.kind === "remote" &&
      !localNames.has(remoteShortName(branch.name, list.remotes)) &&
      matches(branch.name, needle),
  );
  return { local, remote };
};

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/**
 * Whether `name` looks like a branch git would accept. The server has the
 * last word (`git check-ref-format --branch`); this only keeps the picker from
 * offering a create it can already tell will be refused.
 */
export const looksLikeBranchName = (name: string): boolean =>
  name !== "" &&
  name !== "@" &&
  !name.startsWith("-") &&
  !name.startsWith("/") &&
  !name.endsWith("/") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock") &&
  !name.includes("//") &&
  !name.includes("..") &&
  !name.includes("@{") &&
  !/\s/.test(name) &&
  !/[~^:?*[\\]/.test(name) &&
  ![...name].some(isControl) &&
  !name.split("/").some((part) => part.startsWith("."));

/**
 * The name a `Create branch "<query>"` item would create, or null when it is
 * not offered: the query is blank, does not look like a branch name, or
 * already names a branch — local, remote (`origin/x`) or a remote's `x`,
 * which the list already offers to switch to.
 */
export const branchToCreate = (list: GitBranchList, query: string): string | null => {
  const name = query.trim();
  if (!looksLikeBranchName(name)) {
    return null;
  }
  const taken = list.branches.some(
    (branch) =>
      branch.name === name ||
      (branch.kind === "remote" && remoteShortName(branch.name, list.remotes) === name),
  );
  return taken ? null : name;
};

/** What a refused switch or create says: the server's message, else a plain fallback. */
export const branchWriteFailure = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  const error = Cause.squash(exit.cause);
  return isObject(error) && "message" in error && isString(error.message) && error.message !== ""
    ? error.message
    : "The branch could not be switched.";
};
