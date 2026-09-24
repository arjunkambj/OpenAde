/**
 * Which threads the sidebar tree lists.
 *
 * Archived threads live on Settings → Archived threads, not in the tree, or the
 * tree only ever grows. The one exception is the thread that is open right
 * now: its row carries the Unarchive item, and the sidebar never loses track of
 * where you are — the same reason a folded project keeps its open thread.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

export const sidebarThreads = <T extends { threadId: string; status: ThreadSummary["status"] }>(
  threads: ReadonlyArray<T>,
  openThreadId: string | null,
): ReadonlyArray<T> =>
  threads.filter((thread) => thread.status !== "archived" || thread.threadId === openThreadId);
