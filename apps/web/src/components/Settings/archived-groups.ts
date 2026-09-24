/**
 * How Settings → Archived threads groups what it lists.
 *
 * The thread list subscription carries archived threads alongside live ones
 * (only deleted threads drop out of it), so the page needs no RPC of its own:
 * it keeps the archived ones and groups them the way the sidebar tree groups
 * live threads — by project, in the sidebar's project order, with threads
 * whose project is unknown under a last "Other threads" group. Within a
 * group the order the list arrived in is kept: most recently updated first.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

type Listed = { readonly projectId: string; readonly status: ThreadSummary["status"] };

type ArchivedGroup<T> = {
  /** `null` for the "Other threads" group. */
  readonly projectId: string | null;
  readonly name: string;
  readonly threads: ReadonlyArray<T>;
};

export const archivedGroups = <T extends Listed>(
  threads: ReadonlyArray<T>,
  projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>,
): ReadonlyArray<ArchivedGroup<T>> => {
  const archived = threads.filter((thread) => thread.status === "archived");
  const known = new Set(projects.map((project) => project.projectId));

  const groups: ArchivedGroup<T>[] = [];
  for (const project of projects) {
    const list = archived.filter((thread) => thread.projectId === project.projectId);
    if (list.length > 0) {
      groups.push({ projectId: project.projectId, name: project.name, threads: list });
    }
  }
  const orphans = archived.filter((thread) => !known.has(thread.projectId));
  if (orphans.length > 0) {
    groups.push({ projectId: null, name: "Other threads", threads: orphans });
  }
  return groups;
};
