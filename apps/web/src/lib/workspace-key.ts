/**
 * One string for where the user is working: a thread, by its bare id, or —
 * on the New task page, before any thread exists — a project's own folder, as
 * `project:<id>`. The per-workspace view state the dock and header keep (the
 * Files view, the dock's memory, the last pull request link) is keyed by it.
 * It is the same string `terminalOwnerKey` gives the terminal's owner, so a
 * thread's state keeps the key it always had, and ids are UUIDs, so a thread
 * and a project can never meet.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { terminalOwnerKey } from "@poseidon/contracts/terminal";

export const workspaceKey = (scope: {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | null | undefined;
}): string =>
  terminalOwnerKey(
    scope.threadId === undefined || scope.threadId === null
      ? { projectId: scope.projectId }
      : { threadId: scope.threadId },
  );
