/**
 * The sidebar row's status mark: one decision for the icon, the colour and the
 * accessible name, so the three cannot disagree.
 *
 * They did. `awaitingInput` is derived on the server from the pending
 * approvals, questions and plan (`orchestration/state.ts`), and it can be true
 * while `status` is still `running` — resolving one of two approvals mid-turn
 * puts the thread back to `running` with the second still pending. Reading the
 * label off `awaitingInput` but the icon off `status` then spun a muted grey
 * "running" dot on a row whose title and aria-label said "Waiting for you":
 * the one signal the user has to act on was announced to a screen reader and
 * invisible on screen.
 *
 * So: anything waiting on the user outranks anything in flight.
 */

import type { ThreadSummary } from "@OpenAde/contracts/orchestration";
import { type HoneyIcon, AlertTriangle, Bell, Spinner } from "@honeyicons/react";

/** What the row draws, or `null` for a thread with nothing to report. */
export interface ThreadStatusMark {
  readonly icon: HoneyIcon;
  /** Both the tooltip and the accessible name. */
  readonly label: string;
  /** Text colour class for the icon. */
  readonly tone: string;
}

export const threadStatusMark = (
  thread: Pick<ThreadSummary, "status" | "awaitingInput">,
): ThreadStatusMark | null => {
  if (thread.awaitingInput || thread.status === "waiting") {
    return {
      icon: Bell,
      label: "Waiting for you",
      tone: "text-permission",
    };
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
