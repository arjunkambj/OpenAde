/**
 * A request to put the focus in a thread's composer once it is on screen.
 *
 * Starting a thread navigates to it, and its composer mounts only when the
 * thread's detail has loaded — after the old thread's composer has unmounted
 * and taken the focus down to `<body>` with it. So the create flow leaves a
 * request here, and the composer for that thread takes it when it mounts, or
 * at once when it is already mounted (a blank thread handed back). One request
 * is held at a time; a newer one replaces it.
 */

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Ask the composer of `threadId` to take the focus. */
export const requestComposerFocus = (threadId: string): void => {
  pending = threadId;
  for (const listener of listeners) {
    listener();
  }
};

/** True, once, when a request for `threadId` is waiting; it is then spent. */
export const takeComposerFocus = (threadId: string): boolean => {
  if (pending !== threadId) {
    return false;
  }
  pending = null;
  return true;
};

/** Called on every request, so a mounted composer can take one for itself. */
export const onComposerFocusRequest = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
