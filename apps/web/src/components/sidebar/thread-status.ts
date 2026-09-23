/**
 * The sidebar row's status mark: one decision for the icon, the colour and the
 * accessible name, so the three cannot disagree.
 *
 * They did. `awaitingInput` is derived on the server from the pending
 * approvals, questions and plan (`orchestration/state.ts`), and it can be true
 * while `status` is still `running` — resolving one of two approvals mid-turn
 * puts the thread back to `running` with the second still pending. Reading the
 * label off `awaitingInput` but the icon off `status` then spun a muted grey
 * "running" dot on a row whose title and aria-label said the user was needed:
 * the one signal the user has to act on was announced to a screen reader and
 * invisible on screen.
 *
 * So: anything waiting on the user outranks anything in flight.
 *
 * What the thread waits on comes from `awaiting`: an approval or a question
 * needs an answer before the turn can go on, so it takes the permission accent;
 * a finished plan waits for a review but blocks nothing, so it is a plain mark.
 * A summary written before `awaiting` existed, or a `waiting` status with no
 * open decision, still reads as "Needs you" — the louder of the two is the
 * safe guess.
 */

import type { ThreadSummary } from "@OpenAde/contracts/orchestration";
import { type HoneyIcon, AlertTriangle, Bell, ClipboardCheck, Spinner } from "@honeyicons/react";

/** What the row draws, or `null` for a thread with nothing to report. */
export interface ThreadStatusMark {
  readonly icon: HoneyIcon;
  /** Both the tooltip and the accessible name. */
  readonly label: string;
  /** Text colour class for the icon. */
  readonly tone: string;
}

const NEEDS_YOU: ThreadStatusMark = {
  icon: Bell,
  label: "Needs you",
  tone: "text-permission",
};

const PLAN_READY: ThreadStatusMark = {
  icon: ClipboardCheck,
  label: "Plan ready",
  tone: "text-foreground",
};

export const threadStatusMark = (
  thread: Pick<ThreadSummary, "status" | "awaitingInput" | "awaiting">,
): ThreadStatusMark | null => {
  switch (thread.awaiting) {
    case "approval":
    case "question":
      return NEEDS_YOU;
    case "plan":
      return PLAN_READY;
  }
  if (thread.awaitingInput || thread.status === "waiting") {
    return NEEDS_YOU;
  }
  switch (thread.status) {
    case "running":
      return {
        icon: Spinner,
        label: "Running",
        tone: "text-muted-foreground",
      };
    case "error":
      return {
        icon: AlertTriangle,
        label: "Error",
        tone: "text-destructive",
      };
    default:
      // idle, archived and deleted rows say nothing here; the row's own text
      // and the thread view carry those.
      return null;
  }
};
