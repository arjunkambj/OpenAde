/**
 * The order the command palette lists threads in: live ones first, archived
 * ones after them. Archived threads are off the sidebar, so the palette is one
 * of the two ways back to them (the other is Settings → Archived threads); they
 * still should not crowd out the threads in use.
 */

import { THREAD_JUMP_COMMANDS } from "@poseidon/contracts/keybindings";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

export const paletteThreads = <T extends Pick<ThreadSummary, "status">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => [
  ...threads.filter((thread) => thread.status !== "archived"),
  ...threads.filter((thread) => thread.status === "archived"),
];

/**
 * The `thread.jump.N` command that opens `threadId`: N is its row in sidebar
 * order, so only the first nine rows have one. The palette lists threads in
 * its own order, so the number comes from the sidebar's, not the palette's.
 */
export const threadJumpCommand = (
  sidebarOrder: ReadonlyArray<{ readonly threadId: string }>,
  threadId: string,
): string | undefined => {
  const index = sidebarOrder.findIndex((thread) => thread.threadId === threadId);
  return index === -1 ? undefined : THREAD_JUMP_COMMANDS[index];
};
