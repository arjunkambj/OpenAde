/**
 * One answer to "is a turn in flight right now?", so the header, the timeline
 * and the interrupt binding cannot disagree about it.
 *
 * `currentTurnId` is not enough on its own: when a turn completes with
 * messages queued, the client projection goes straight to `running` with the
 * id null, ahead of the server's drain requesting the next turn. That window
 * has to read as in flight too, or the composer offers an unqueued send the
 * server rejects as "a turn is already running".
 */

import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

export const turnInFlight = (snapshot: ThreadDetailSnapshot): boolean =>
  snapshot.currentTurnId !== null || snapshot.status === "running";
