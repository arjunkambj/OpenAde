/**
 * What the "remove this project" confirmation actually says.
 *
 * `project.remove` does more than its name: `ProviderCommandReactor` dispatches
 * a `thread.delete` for every thread under it, so the sentence has to name
 * them, and the count changes the grammar three ways. It is a function with a
 * test rather than a template in the dialog because the zero-thread wording is
 * the one a first run sees and the one that read "The project are deleted".
 *
 * Nor does it remove a worktree: deleting a thread one at a time offers that,
 * removing the project does not, so when some of its threads have worktrees
 * the sentence says they stay on disk with their branches.
 */

export const projectRemovalWarning = (
  name: string,
  threadCount: number,
  workspaceRoot: string,
  worktreeCount = 0,
): string => {
  const subject =
    threadCount === 0
      ? `${name} is removed from OpenAde.`
      : threadCount === 1
        ? `${name} and its one thread are removed from OpenAde, with that thread's transcript and turn checkpoints.`
        : `${name} and its ${threadCount} threads are removed from OpenAde, with their transcripts and turn checkpoints.`;
  const worktrees =
    worktreeCount === 0
      ? ""
      : worktreeCount === 1
        ? " The worktree one of its threads works in is not removed either: it stays on disk, with its branch."
        : ` The ${worktreeCount} worktrees its threads work in are not removed either: they stay on disk, with their branches.`;
  return `${subject} Nothing in ${workspaceRoot} is touched.${worktrees}`;
};
