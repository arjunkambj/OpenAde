/**
 * "The user is back": the window regains focus, or the page turns visible
 * again. Files change outside a turn while the app is not in front — in an
 * editor, in a terminal — so this is when a read of the workspace may have
 * gone stale, and the moment to refetch it without polling.
 *
 * Coming back usually fires both events, one right after the other; a second
 * return within `RETURN_DEDUPE_MS` of the first is the same return, so the
 * caller refetches once.
 */

import * as React from "react";

export const RETURN_DEDUPE_MS = 1000;

/** The two event sources, as `window` and `document` provide them; injectable for tests. */
export interface ReturnSources {
  readonly window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly document: Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
    readonly visibilityState: DocumentVisibilityState;
  };
  readonly now: () => number;
}

/** Calls `onReturn` on each return; answers the unsubscribe. */
export const subscribeWindowReturn = (
  onReturn: () => void,
  sources: ReturnSources = { window, document, now: Date.now },
): (() => void) => {
  let last = Number.NEGATIVE_INFINITY;
  const returned = () => {
    const at = sources.now();
    if (at - last < RETURN_DEDUPE_MS) {
      return;
    }
    last = at;
    onReturn();
  };
  const onVisibility = () => {
    if (sources.document.visibilityState === "visible") {
      returned();
    }
  };
  sources.window.addEventListener("focus", returned);
  sources.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    sources.window.removeEventListener("focus", returned);
    sources.document.removeEventListener("visibilitychange", onVisibility);
  };
};

/** `subscribeWindowReturn` for the component's lifetime; the latest `onReturn` is the one called. */
export const useWindowReturn = (onReturn: () => void): void => {
  const latest = React.useRef(onReturn);
  latest.current = onReturn;
  React.useEffect(() => subscribeWindowReturn(() => latest.current()), []);
};
