/**
 * "The user is back": the window regains focus, or the page turns visible
 * again. Files change outside a turn while the app is not in front — in an
 * editor, in a terminal — so this is when a read of the workspace may have
 * gone stale, and the moment to refetch it without polling.
 *
 * Coming back usually fires both events, one right after the other; a second
 * return within `RETURN_DEDUPE_MS` of the first is the same return, so the
 * caller refetches once.
 *
 * Several components that refetch the same thing — each badge counting one
 * project's shells, say — share one subscription per key
 * (`useSharedWindowReturn`), so a return refetches it once rather than once
 * per component.
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

/**
 * `subscribeWindowReturn` shared by key: however many callers subscribe under
 * one key, a return calls one of them — the earliest still subscribed — and
 * the key's listeners go once the last caller leaves. For callers whose
 * `onReturn` all do the same thing, such as refreshing one shared atom.
 */
export const makeSharedWindowReturn = (sources?: ReturnSources) => {
  const byKey = new Map<unknown, { callbacks: Set<() => void>; stop: () => void }>();
  return (key: unknown, onReturn: () => void): (() => void) => {
    let entry = byKey.get(key);
    if (entry === undefined) {
      const callbacks = new Set<() => void>();
      const stop = subscribeWindowReturn(() => callbacks.values().next().value?.(), sources);
      entry = { callbacks, stop };
      byKey.set(key, entry);
    }
    const shared = entry;
    const mine = () => onReturn();
    shared.callbacks.add(mine);
    return () => {
      shared.callbacks.delete(mine);
      if (shared.callbacks.size === 0) {
        shared.stop();
        byKey.delete(key);
      }
    };
  };
};

const sharedWindowReturn = makeSharedWindowReturn();

/**
 * `useWindowReturn` shared with every other caller under the same `key`: one
 * call per return for all of them together. The latest `onReturn` of the
 * caller chosen is the one called.
 */
export const useSharedWindowReturn = (key: unknown, onReturn: () => void): void => {
  const latest = React.useRef(onReturn);
  latest.current = onReturn;
  React.useEffect(() => sharedWindowReturn(key, () => latest.current()), [key]);
};

/** `subscribeWindowReturn` for the component's lifetime; the latest `onReturn` is the one called. */
export const useWindowReturn = (onReturn: () => void): void => {
  const latest = React.useRef(onReturn);
  latest.current = onReturn;
  React.useEffect(() => subscribeWindowReturn(() => latest.current()), []);
};
