/**
 * What sending the draft means right now: start a turn, queue behind the
 * running one, or steer it — join the running turn with the new message.
 *
 * Steering needs a turn in flight and a harness that said it can take a
 * message mid-turn: `capabilities.steering` on the thread's bound session,
 * the same fact the decider steers by. Before the session binds nothing has
 * said so, and the decider queues a steer then; so does the composer.
 * Otherwise a busy thread queues,
 * exactly as it always has: the decider rejects a second turn, so "send" on a
 * running thread means queue. The queue chord (Cmd/Ctrl+Enter) always
 * queues, steering or not, so a follow-up that should wait for the turn to
 * finish still can. Idle, the chord queues too; the decider starts a turn for
 * a queued message when nothing is running, as it did before steering.
 */

import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

export type SendMode = "start" | "queue" | "steer";

/** A turn is in flight and the thread's bound session takes messages into it. */
export const canSteer = (
  running: boolean,
  sessionCapabilities: ConnectorCapabilities | null | undefined,
): boolean => running && sessionCapabilities?.steering === true;

export interface SendModeInput {
  readonly running: boolean;
  readonly steerable: boolean;
  /** The explicit queue chord, rather than a plain Enter or the send button. */
  readonly queueChord: boolean;
}

export const sendMode = ({ running, steerable, queueChord }: SendModeInput): SendMode => {
  if (queueChord) {
    return "queue";
  }
  if (!running) {
    return "start";
  }
  return steerable ? "steer" : "queue";
};
