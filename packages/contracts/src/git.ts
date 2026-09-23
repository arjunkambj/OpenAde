/**
 * The git shapes a thread and the git RPCs share, and the branch, commit,
 * push and pull-request RPCs.
 *
 * Kept apart from `rpc.ts` so the branch, commit and worktree surface can grow
 * without pushing the RPC group past its size limit: the RPCs are defined
 * here, their method names are spread into `RPC_METHODS`, and `rpc.ts` lists
 * them in `OpenAdeRpcGroup`. `orchestration` imports `ThreadWorktree` from
 * here because a thread records its worktree when it is created.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { OpenAdeRpcError } from "./rpcError";

/**
 * The git worktree a thread works in instead of its project's folder.
 *
 * `path` is absolute (the decider refuses anything else) and is the thread's
 * workspace root: its session, its checkpoints, its diff and its `@` search
 * all run there. `branch` is the branch checked out in it, and `baseBranch`
 * the one it was cut from, when that is known. A thread without a worktree is
 * a local thread on the project's own root.
 */
export const ThreadWorktree = Schema.Struct({
  path: NonEmptyString,
  branch: NonEmptyString,
  baseBranch: Schema.optional(NonEmptyString),
});
export type ThreadWorktree = typeof ThreadWorktree.Type;

// ── Branches ───────────────────────────────────────────────────

/**
 * One branch. `name` is what `git switch` takes: `feature` for a local
 * branch, `origin/feature` for a remote-tracking one. `upstream` is the
 * branch a local one tracks. `worktreePath` is set when the branch is checked
 * out in a different worktree than the one the list was read in — git refuses
 * to check it out a second time, so a picker offers it disabled.
 */
export const GitBranch = Schema.Struct({
  name: NonEmptyString,
  kind: Schema.Literals(["local", "remote"]),
  isCurrent: Schema.Boolean,
  upstream: Schema.optional(NonEmptyString),
  worktreePath: Schema.optional(NonEmptyString),
});
export type GitBranch = typeof GitBranch.Type;

/**
 * Every branch of one workspace, local ones first. `current` is `null` on a
 * detached HEAD. `defaultBranch` is the branch new work is cut from: the
 * remote's HEAD when it is known, else a local `main` or `master`, else
 * `init.defaultBranch` when that branch exists, else the current branch.
 * `isRepository: false` carries the meaning it does on `GitStatus`.
 */
export const GitBranchList = Schema.Struct({
  isRepository: Schema.Boolean,
  current: Schema.NullOr(NonEmptyString),
  defaultBranch: Schema.NullOr(NonEmptyString),
  remotes: Schema.Array(NonEmptyString),
  branches: Schema.Array(GitBranch),
});
export type GitBranchList = typeof GitBranchList.Type;

// ── Commit, push, pull request ─────────────────────────────────

/**
 * The commit `git.commit` made. `subject` is its first line as git stored it;
 * `branch` is the branch it landed on, `null` on a detached HEAD.
 */
export const GitCommitResult = Schema.Struct({
  sha: NonEmptyString,
  subject: Schema.String,
  branch: Schema.NullOr(NonEmptyString),
});
export type GitCommitResult = typeof GitCommitResult.Type;

/**
 * Where `git.push` pushed the current branch. `setUpstream` is true when the
 * branch had no upstream yet and this push set one (`git push -u`).
 */
export const GitPushResult = Schema.Struct({
  remote: NonEmptyString,
  branch: NonEmptyString,
  setUpstream: Schema.Boolean,
});
export type GitPushResult = typeof GitPushResult.Type;

/**
 * The pull request for the current branch. `created: false` means one was
 * already open for it, and `url` is that one's.
 */
export const GitPullRequestResult = Schema.Struct({
  url: NonEmptyString,
  created: Schema.Boolean,
});
export type GitPullRequestResult = typeof GitPullRequestResult.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const GIT_RPC_METHODS = {
  gitBranches: "git.branches",
  gitBranchCreate: "git.branch.create",
  gitCheckout: "git.checkout",
  gitCommit: "git.commit",
  gitPush: "git.push",
  gitPullRequestCreate: "git.pullRequest.create",
} as const;

/** The branches of the thread's root when `threadId` is set, the project's otherwise. */
export const GitBranchesRpc = Rpc.make(GIT_RPC_METHODS.gitBranches, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitBranchList,
  error: OpenAdeRpcError,
});

/**
 * Cuts `name` from `from` (default `HEAD`) without tracking it, so a branch
 * cut from `origin/main` never pushes onto main. `checkout` switches to it as
 * well, under the same guards `git.checkout` has. Answers the new list.
 */
export const GitBranchCreateRpc = Rpc.make(GIT_RPC_METHODS.gitBranchCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    name: NonEmptyString,
    from: Schema.optional(NonEmptyString),
    checkout: Schema.Boolean,
  }),
  success: GitBranchList,
  error: OpenAdeRpcError,
});

/**
 * Switches the workspace to `branch`; a remote branch becomes a local one
 * tracking it. Refused with `conflict` while a tracked file has uncommitted
 * changes or a turn is running in that workspace. Answers the new list.
 */
export const GitBranchCheckoutRpc = Rpc.make(GIT_RPC_METHODS.gitCheckout, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    branch: NonEmptyString,
  }),
  success: GitBranchList,
  error: OpenAdeRpcError,
});

/**
 * Commits with the user's own git identity and hooks. Without `paths` every
 * change is staged (`git add -A`); with them the index is reset first and
 * only those paths are staged, so nothing else rides along. `conflict` when
 * nothing ends up staged, when a hook refuses (with its own output), or while
 * a turn is running in that workspace.
 */
export const GitCommitRpc = Rpc.make(GIT_RPC_METHODS.gitCommit, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    message: NonEmptyString,
    paths: Schema.optional(Schema.Array(NonEmptyString)),
  }),
  success: GitCommitResult,
  error: OpenAdeRpcError,
});

/**
 * Pushes the current branch: plainly when it has an upstream, with `-u` to
 * its remote (`branch.<name>.remote`, else `origin`, else the only remote)
 * when it has none. `unavailable` when the repository has no remote.
 */
export const GitPushRpc = Rpc.make(GIT_RPC_METHODS.gitPush, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitPushResult,
  error: OpenAdeRpcError,
});

/**
 * Opens a pull request for the current branch with the GitHub CLI, into
 * `base` — else the branch the thread's worktree was cut from, else the
 * default branch. `unavailable` when `gh` is missing or not signed in.
 */
export const GitPullRequestCreateRpc = Rpc.make(GIT_RPC_METHODS.gitPullRequestCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    title: NonEmptyString,
    body: Schema.String,
    base: Schema.optional(NonEmptyString),
  }),
  success: GitPullRequestResult,
  error: OpenAdeRpcError,
});
