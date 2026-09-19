/**
 * One answer to "is a turn in flight right now?", so the header, the timeline
 * and the interrupt binding cannot disagree about it.
 *
 * `currentTurnId` is not enough on its own: the client projection fills it on
 * `thread.turn.started`, while `status` goes to `running` one event earlier on
 * `thread.turn.requested`. A connector that is slow to start — or never gets
 * past `requested` — leaves the id null for the whole time the user is
 * actually waiting, which is precisely when they reach for Escape.
 */

import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

export const turnInFlight = (snapshot: ThreadDetailSnapshot): boolean =>
  snapshot.currentTurnId !== null || snapshot.status === "running";
