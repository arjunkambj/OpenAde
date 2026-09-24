/**
 * The order the sidebar lists threads in, as data.
 *
 * The tree draws it and the thread keys walk it: `Mod+1`…`Mod+9` open the Nth
 * row and `Mod+Shift+[` / `Mod+Shift+]` step to the row above or below. Both
 * derive from `sidebarThreadGroups` here, so the Nth thread a key opens is the
 * Nth row on screen and the two cannot drift apart.
 *
 * The rule: projects in their listed order, each with its threads in list
 * order — a folded project contributes only the open thread, which the tree
 * keeps showing under it — then the threads whose project is gone ("Other
 * threads"). Archived threads are left out except the open one, by
 * `sidebarThreads`.
 */

import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { sidebarThreads } from "@/components/sidebar/visible-threads";

interface OrderedThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly status: ThreadSummary["status"];
}

export interface SidebarThreadGroups<T> {
  /** Each known project's listed threads, folding already applied. */
  readonly byProject: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Listed threads whose project is not in the project list. */
  readonly orphans: ReadonlyArray<T>;
}

/** The sidebar's rows, grouped the way the tree draws them. */
export const sidebarThreadGroups = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
): SidebarThreadGroups<T> => {
  const known = new Set(projects.map((project) => project.projectId));
  const byProject = new Map<string, Array<T>>();
  const orphans: Array<T> = [];
  for (const thread of sidebarThreads(threads, openThreadId)) {
    if (!known.has(thread.projectId)) {
      orphans.push(thread);
      continue;
    }
    if (collapsed.has(thread.projectId) && thread.threadId !== openThreadId) {
      continue;
    }
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  return { byProject, orphans };
};

/** Every thread row in the sidebar, top to bottom. */
export const sidebarThreadOrder = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
): ReadonlyArray<T> => {
  const { byProject, orphans } = sidebarThreadGroups(projects, threads, collapsed, openThreadId);
  return [...projects.flatMap((project) => byProject.get(project.projectId) ?? []), ...orphans];
};

/** The Nth row (1-based), or `undefined` past the end — `Mod+9` on a short list. */
export const nthThread = <T>(order: ReadonlyArray<T>, n: number): T | undefined =>
  Number.isInteger(n) && n >= 1 ? order[n - 1] : undefined;

/**
 * The row `step` away from the open thread, wrapping at both ends. With no
 * open thread (or one the sidebar does not list) the first step lands on the
 * first row going down and the last row going up.
 */
export const neighbourThread = <T extends { readonly threadId: string }>(
  order: ReadonlyArray<T>,
  openThreadId: string | null,
  step: 1 | -1,
): T | undefined => {
  if (order.length === 0) {
    return undefined;
  }
  const at = openThreadId === null ? -1 : order.findIndex((t) => t.threadId === openThreadId);
  if (at === -1) {
    return step === 1 ? order[0] : order[order.length - 1];
  }
  return order[(at + step + order.length) % order.length];
};

/**
 * Where "new thread in this project" starts one: the open thread's project,
 * else the project a thread was last started in, else the first listed — each
 * only while it is still in the project list. `undefined` with no projects.
 */
export const projectForNewThread = <P extends { readonly projectId: string }>(
  projects: ReadonlyArray<P>,
  openThreadProjectId: string | undefined,
  lastProjectId: string | null,
): P | undefined =>
  projects.find((project) => project.projectId === openThreadProjectId) ??
  projects.find((project) => project.projectId === lastProjectId) ??
  projects[0];
