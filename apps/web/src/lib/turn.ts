/**
 * One answer to "is a turn in flight right now?", so the header, the timeline
 * and the interrupt binding cannot disagree about it — and, for the New task
 * page, the nearest the thread list comes to one for a project's own folder.
 *
 * `currentTurnId` is not enough on its own: when a turn completes with
 * messages queued, the client projection goes straight to `running` with the
 * id null, ahead of the server's drain requesting the next turn. That window
 * has to read as in flight too, or the composer offers an unqueued send the
 * server rejects as "a turn is already running".
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot, ThreadSummary } from "@poseidon/contracts/orchestration";

export const turnInFlight = (snapshot: ThreadDetailSnapshot): boolean =>
  snapshot.currentTurnId !== null || snapshot.status === "running";

/**
 * Whether a turn is running in a project's own folder, as far as the thread
 * list can tell: a local thread of the project — one with no worktree, so it
 * works in that folder — whose status is `running`. The New task page's git
 * actions use it in place of `turnInFlight`, having no thread of their own.
 *
 * The list carries no turn id, so a turn paused on an approval or a question
 * (`waiting`) is not counted: `waiting` also covers a thread whose turn has
 * ended with a plan still to answer, and counting that would hold the button
 * down with nothing running. The server's own check (`requireIdle`) still
 * refuses a commit under any turn in that folder, with its reason.
 */
export const projectFolderTurnRunning = (
  threads: ReadonlyArray<ThreadSummary>,
  projectId: ProjectId,
): boolean =>
  threads.some(
    (thread) =>
      thread.projectId === projectId &&
      thread.worktree === undefined &&
      thread.status === "running",
  );
