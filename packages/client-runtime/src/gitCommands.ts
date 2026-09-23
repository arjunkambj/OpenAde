/**
 * The git writes a thread's start, end and header need, built on the same
 * runtime and git atoms as the Changes pane's reads.
 *
 * - `worktreeCreateAtom` — `git.worktree.create`: cuts a new thread's branch
 *   and directory, and resolves with the `ThreadWorktree` that `thread.create`
 *   records.
 * - `worktreeSetupAtom` — `git.worktree.setup`: runs the project's setup
 *   script in that worktree. It is a stream, and the atom's value is the run
 *   so far (`WorktreeSetupProgress`), updated as each frame arrives — the
 *   start screen shows the output while it grows, and a `promise`-mode setter
 *   resolves with the finished run. Interrupting the atom ends the stream,
 *   which kills the script on the server.
 * - `worktreeRemoveAtom` — `git.worktree.remove`: discards a worktree, keeping
 *   its branch.
 *
 * - `gitCommitAtom`, `gitPushAtom`, `gitPullRequestAtom` — `git.commit`,
 *   `git.push` and `git.pullRequest.create`, the header's git actions control
 *   runs them as stacked steps. Each fails with the server's refusal for the
 *   step's toast to show.
 *
 * The worktree writes refresh the project's branch list: a create adds a
 * branch and a remove frees one that was checked out elsewhere. A commit or a
 * push moves the status (files, ahead, upstream) and the diffs of every scope
 * on that repository, so both refetch every git read of the project, the way
 * a branch switch does. Opening a pull request changes nothing git can see,
 * so it refetches nothing.
 */

import type { ThreadWorktree, WorktreeSetupFrame } from "@OpenAde/contracts/git";
import type { ProjectId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, type ConnectionStateRef } from "./connection";
import type { GitAtoms, GitScope } from "./gitAtoms";

/**
 * A setup run so far. `exit` is `null` until the script has finished; `code`
 * is `null` when it was killed, with the `signal` that did it. `skipped` means
 * the project has no setup script, and nothing ran.
 */
export interface WorktreeSetupProgress {
  readonly output: string;
  readonly exit: { readonly code: number | null; readonly signal?: string } | null;
  readonly skipped: boolean;
}

export const emptySetupProgress: WorktreeSetupProgress = { output: "", exit: null, skipped: false };

/** Folds one frame of the stream into the run so far. */
export const scanSetupFrame = (
  progress: WorktreeSetupProgress,
  frame: WorktreeSetupFrame,
): WorktreeSetupProgress => {
  switch (frame.kind) {
    case "skipped":
      return { ...progress, skipped: true };
    case "output":
      return { ...progress, output: progress.output + frame.text };
    case "exit":
      return {
        ...progress,
        exit: {
          code: frame.exitCode,
          ...(frame.signal === undefined ? {} : { signal: frame.signal }),
        },
      };
  }
};

export interface WorktreeCreate {
  readonly projectId: ProjectId;
  /** Free text the branch and directory are named from — a first message will do. */
  readonly name: string;
  readonly baseBranch?: string | undefined;
}

export interface WorktreeTarget {
  readonly projectId: ProjectId;
  readonly path: string;
}

export interface WorktreeRemove extends WorktreeTarget {
  /** Remove it even with uncommitted or untracked work in it. */
  readonly force?: boolean | undefined;
}

/** A commit of every change, or of `paths` only when they are given. */
export interface GitCommit extends GitScope {
  readonly message: string;
  readonly paths?: ReadonlyArray<string> | undefined;
}

/**
 * A pull request from the current branch. The server picks the base: the
 * branch the thread's worktree was cut from, else the default branch.
 */
export interface GitPullRequest extends GitScope {
  readonly title: string;
  readonly body: string;
}

/** The scope half of a payload, without an absent `threadId` on the wire. */
const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

export const makeGitCommands = (
  runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>,
  git: GitAtoms,
) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  /** Fails with the server's refusal: not a repository, a bad prefix, an unknown base. */
  const worktreeCreateAtom = runtime.fn((input: WorktreeCreate, get) =>
    Effect.gen(function* () {
      const worktree: ThreadWorktree = yield* Effect.flatMap(client, (c) =>
        c["git.worktree.create"]({
          projectId: input.projectId,
          name: input.name,
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
        }),
      );
      get.registry.refresh(git.gitBranchesAtom({ projectId: input.projectId }));
      return worktree;
    }),
  );

  const worktreeSetupAtom = runtime.fn((input: WorktreeTarget) =>
    Effect.map(client, (c) =>
      c["git.worktree.setup"]({ projectId: input.projectId, path: input.path }),
    ).pipe(Stream.unwrap, Stream.scan(emptySetupProgress, scanSetupFrame)),
  );

  /** Fails with `conflict` while a thread works there, or on unsaved work without `force`. */
  const worktreeRemoveAtom = runtime.fn((input: WorktreeRemove, get) =>
    Effect.gen(function* () {
      yield* Effect.flatMap(client, (c) =>
        c["git.worktree.remove"]({
          projectId: input.projectId,
          path: input.path,
          ...(input.force === undefined ? {} : { force: input.force }),
        }),
      );
      get.registry.refresh(git.gitBranchesAtom({ projectId: input.projectId }));
    }),
  );

  /** Fails with `conflict` on nothing to commit, a hook's refusal or a running turn. */
  const gitCommitAtom = runtime.fn((input: GitCommit, get) =>
    Effect.gen(function* () {
      const result = yield* Effect.flatMap(client, (c) =>
        c["git.commit"]({
          ...scopePayload(input),
          message: input.message,
          ...(input.paths === undefined ? {} : { paths: input.paths }),
        }),
      );
      git.refreshProject(get.registry, input.projectId);
      return result;
    }),
  );

  /** Fails with `unavailable` without a remote, or with git's own refusal. */
  const gitPushAtom = runtime.fn((input: GitScope, get) =>
    Effect.gen(function* () {
      const result = yield* Effect.flatMap(client, (c) => c["git.push"](scopePayload(input)));
      git.refreshProject(get.registry, input.projectId);
      return result;
    }),
  );

  /** Fails with `unavailable` when `gh` is missing or signed out. */
  const gitPullRequestAtom = runtime.fn((input: GitPullRequest) =>
    Effect.flatMap(client, (c) =>
      c["git.pullRequest.create"]({
        ...scopePayload(input),
        title: input.title,
        body: input.body,
      }),
    ),
  );

  return {
    worktreeCreateAtom,
    worktreeSetupAtom,
    worktreeRemoveAtom,
    gitCommitAtom,
    gitPushAtom,
    gitPullRequestAtom,
  };
};

export type GitCommands = ReturnType<typeof makeGitCommands>;
