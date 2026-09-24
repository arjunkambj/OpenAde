/**
 * The dock launcher's words and keys, as pure functions.
 *
 * The launcher (`?pane=home`) is what an open dock shows before a tab is
 * chosen: one row per tab, each with a live line of status, so opening the
 * dock answers "is there anything to look at?" before it commits to a tab.
 *
 * - Changes counts the workspace's uncommitted files off `git.status`, with
 *   the summed `+`/`−` of the same working-tree diff the Changes tab shows.
 *   A workspace git does not track has nothing to compare, so its row is
 *   disabled and says why. The Changes tab's badge is the same count.
 * - Browser counts the thread's open tabs, or says the agent is using the
 *   browser while it is (`agentUsingBrowser`).
 * - Files names the directory the Files tab searches: the thread's worktree,
 *   or the project's folder.
 *
 * Rows move with the arrow keys (and Home/End), skipping disabled ones; while
 * the launcher has focus a row's first letter — C, B, F — picks it.
 */

import type { GitQuery } from "@OpenAde/client-runtime/gitAtoms";
import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import { AsyncResult } from "effect/unstable/reactivity";

import type { DockTab } from "./dock-toggle";

/**
 * A git read as the launcher sees it: `null` before the first answer, `broken`
 * when the atom itself failed, else the RPC's own outcome.
 */
export type GitRead<A> = GitQuery<A> | { readonly _tag: "broken" } | null;

const BROKEN = { _tag: "broken" } as const;

/** A git atom's state as a `GitRead`. */
export const readGit = <A>(result: AsyncResult.AsyncResult<GitQuery<A>, unknown>): GitRead<A> =>
  AsyncResult.isSuccess(result) ? result.value : AsyncResult.isFailure(result) ? BROKEN : null;

export interface LauncherStatus {
  readonly text: string;
  /** Set when the tab has nothing it could show; `text` is the reason. */
  readonly disabled: boolean;
  readonly additions?: number;
  readonly deletions?: number;
}

/** `git.status` says git does not track this workspace (or the server does not know it). */
const isRepoless = (status: GitStatus): boolean =>
  status.isRepository === false || (status.branch === null && status.files.length === 0);

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** How many files have uncommitted changes, or `null` when there is no count to show. */
export const uncommittedCount = (status: GitRead<GitStatus>): number | null =>
  status?._tag === "ok" && !isRepoless(status.value) ? status.value.files.length : null;

export const changesStatus = (
  connected: boolean,
  status: GitRead<GitStatus>,
  diff: GitRead<GitDiff>,
): LauncherStatus => {
  if (status?._tag === "ok" && isRepoless(status.value)) {
    return { text: "Not a git repository", disabled: true };
  }
  if (status === null) {
    return { text: connected ? "Checking for changes…" : "Not connected", disabled: false };
  }
  if (status._tag !== "ok") {
    return { text: "Could not read git status", disabled: false };
  }
  const count = status.value.files.length;
  if (count === 0) {
    return { text: "No changes", disabled: false };
  }
  const text = plural(count, "changed file", "changed files");
  if (diff?._tag !== "ok") {
    return { text, disabled: false };
  }
  let additions = 0;
  let deletions = 0;
  for (const file of diff.value.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { text, disabled: false, additions, deletions };
};

export const browserStatus = (tabCount: number, agentUsing: boolean): LauncherStatus => ({
  text: agentUsing
    ? "Agent is using the browser"
    : tabCount === 0
      ? "No tabs open"
      : `${plural(tabCount, "tab", "tabs")} open`,
  disabled: false,
});

/** The last segment of a path, POSIX or Windows, ignoring a trailing separator. */
export const folderName = (path: string): string => {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
};

export const filesStatus = (root: string | null): LauncherStatus => ({
  text: root === null ? "This project's files" : folderName(root),
  disabled: false,
});

/**
 * The row focus moves to for `key` from `current`, over rows whose
 * `enabled` flags are given in order: arrows step and wrap, Home and End go to
 * the ends, and disabled rows are skipped. `null` when the key does not move
 * focus or no row can take it.
 */
export const launcherFocusMove = (
  key: string,
  enabled: ReadonlyArray<boolean>,
  current: number,
): number | null => {
  const candidates = enabled.flatMap((on, index) => (on ? [index] : []));
  if (candidates.length === 0) {
    return null;
  }
  switch (key) {
    case "Home":
      return candidates[0] ?? null;
    case "End":
      return candidates.at(-1) ?? null;
    case "ArrowDown":
      return candidates.find((index) => index > current) ?? candidates[0] ?? null;
    case "ArrowUp":
      return candidates.findLast((index) => index < current) ?? candidates.at(-1) ?? null;
    default:
      return null;
  }
};

/** The tab a bare letter picks — its label's first letter — when that row is enabled. */
export const launcherLetterPick = (
  key: string,
  rows: ReadonlyArray<{
    readonly tab: DockTab;
    readonly label: string;
    readonly disabled: boolean;
  }>,
): DockTab | null => {
  if (key.length !== 1) {
    return null;
  }
  const letter = key.toLowerCase();
  const row = rows.find((candidate) => candidate.label.toLowerCase().startsWith(letter));
  return row === undefined || row.disabled ? null : row.tab;
};
