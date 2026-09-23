/**
 * The git shapes a thread and the git RPCs share.
 *
 * Kept apart from `rpc.ts` so the branch, commit and worktree surface can grow
 * without pushing the RPC group past its size limit; `orchestration` imports
 * `ThreadWorktree` from here because a thread records its worktree when it is
 * created.
 */

import * as Schema from "effect/Schema";

import { NonEmptyString } from "./base";

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
