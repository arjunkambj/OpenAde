/**
 * What the "remove this project" confirmation actually says.
 *
 * `project.remove` does more than its name: `ProviderCommandReactor` dispatches
 * a `thread.delete` for every thread under it, so the sentence has to name
 * them, and the count changes the grammar three ways. It is a function with a
 * test rather than a template in the dialog because the zero-thread wording is
 * the one a first run sees and the one that read "The project are deleted".
 */

export const projectRemovalWarning = (
  name: string,
  threadCount: number,
  workspaceRoot: string,
): string => {
  const subject =
    threadCount === 0
      ? `${name} is removed from OpenAde.`
      : threadCount === 1
        ? `${name} and its one thread are removed from OpenAde, with that thread's transcript and turn checkpoints.`
        : `${name} and its ${threadCount} threads are removed from OpenAde, with their transcripts and turn checkpoints.`;
  return `${subject} Nothing in ${workspaceRoot} is touched.`;
};
