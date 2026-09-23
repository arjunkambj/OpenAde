/**
 * The order the command palette lists threads in: live ones first, archived
 * ones after them. Archived threads are off the sidebar, so the palette is one
 * of the two ways back to them (the other is Settings → Archived threads); they
 * still should not crowd out the threads in use.
 */

import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

export const paletteThreads = <T extends Pick<ThreadSummary, "status">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => [
  ...threads.filter((thread) => thread.status !== "archived"),
  ...threads.filter((thread) => thread.status === "archived"),
];
