/**
 * When this window last sent a message to each thread — presentation state,
 * in memory only.
 *
 * The timeline's send anchor (`components/timeline/send-anchor.ts`) takes the
 * scroll from a reader who scrolled away only for a send made here, just now.
 * A message row can also appear because the server drained a message queued
 * minutes ago, or because another window sent it; neither is this reader
 * asking to see it, so neither pulls the list away from what they are reading.
 *
 * The composer notes the send as it dispatches, after any upload, so the
 * window only has to cover the round trip and the turn starting.
 */

/** How long after a send its message row still counts as this reader's. */
export const LOCAL_SEND_WINDOW_MS = 10_000;

const sentAt = new Map<string, number>();

/** This window is sending a message to `threadId` now. */
export const noteLocalSend = (threadId: string, now: number = Date.now()): void => {
  sentAt.set(threadId, now);
};

/** Whether this window sent a message to `threadId` within the window. */
export const sentHereRecently = (threadId: string, now: number = Date.now()): boolean => {
  const at = sentAt.get(threadId);
  return at !== undefined && now - at >= 0 && now - at <= LOCAL_SEND_WINDOW_MS;
};
