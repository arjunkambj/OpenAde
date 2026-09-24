/**
 * The scroll holds the timeline's list runs, apart from the hook that decides
 * when (`use-send-anchor.ts`), so they are testable against a fake list.
 *
 * `placeAnchor` carries a just-sent message to the top of the viewport and
 * holds it there; `holdSettledAnchor` holds it there again when its turn
 * settles; `keepInView` holds the row the reader was on where it sat while
 * expand-all or collapse-all add or remove rows above it. Both correct
 * the scroll without animation on every frame the geometry moves, until it
 * has been still for `HOLD_QUIET_MS`, and hand back a cancel the reader's own
 * scroll calls.
 */

import type { LegendListRef } from "@legendapp/list/react";

import type { TimelineRow } from "./fold";
import { isScrollKey, pickViewAnchor, type ViewAnchor, viewAnchors } from "./send-anchor";

/** Distance from the viewport top to the held message, in px. */
export const ANCHOR_OFFSET = 16;
/** The hold ends once the geometry has not moved for this long. */
const HOLD_QUIET_MS = 450;
/** And always by this long, so a list that never settles is not pinned. */
const HOLD_MAX_MS = 3_000;
/** The eased approach gets this long before the hold takes over regardless. */
const APPROACH_MAX_MS = 1_500;
/** How long a send waits for the list to measure the reserve under it. */
const RESERVE_WAIT_MAX_MS = 500;

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The list's scroll offset in its rows' coordinates: the row positions start
 * below the content's top padding, which the scroll offset counts.
 */
export const contentScrollTop = (list: LegendListRef): number => {
  const node = list.getScrollableNode();
  const content = node.firstElementChild;
  const padding =
    content instanceof HTMLElement ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0;
  return node.scrollTop - (Number.isFinite(padding) ? padding : 0);
};

/** Where the rows on screen, and those just above, sit now. */
export const currentViewAnchors = (list: LegendListRef): ReadonlyArray<ViewAnchor> => {
  const state = list.getState();
  const top = contentScrollTop(list);
  const rowIds = state.data.map((row: TimelineRow) => row.id);
  return viewAnchors(rowIds, state.positionAtIndex, top, top + state.scrollLength);
};

/**
 * Hold the first of `anchors` the list still holds where it sat on screen,
 * correcting the scroll before paint and then on every frame the rows move,
 * until they have been still for `HOLD_QUIET_MS`; returns the cancel.
 */
export function keepInView(list: LegendListRef, anchors: ReadonlyArray<ViewAnchor>): () => void {
  const state = list.getState();
  const anchor = pickViewAnchor(anchors, (rowId) => state.indexByKey(rowId) !== undefined);
  if (anchor === undefined) {
    return () => {};
  }
  let frame = 0;
  // Whether the row had drifted, and was put back.
  const correct = (): boolean => {
    const position = list.getState().positionByKey(anchor.rowId);
    if (position === undefined) {
      return false;
    }
    const drift = position - contentScrollTop(list) - anchor.offset;
    if (Math.abs(drift) < 1) {
      return false;
    }
    list.getScrollableNode().scrollTop += drift;
    return true;
  };
  correct();
  const started = performance.now();
  let lastMove = started;
  const step = (now: number) => {
    if (correct()) {
      lastMove = now;
    }
    if (now - lastMove < HOLD_QUIET_MS && now - started < HOLD_MAX_MS) {
      frame = requestAnimationFrame(step);
    }
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/**
 * Hold the anchored message at the top as its turn settles; returns the
 * cancel. The fold closes the turn's work under it and the Working row goes,
 * so the rows shrink, while the reserve under the message catches up a frame
 * late: the browser clamps the scroll down meanwhile. The message is already
 * placed, so there is nothing to ease towards — an eased `placeAnchor` would
 * aim at the clamped geometry and paint the message lower first. This puts it
 * back before paint, from the settling render's layout effect, and on every
 * frame after until the rows are still (`keepInView`).
 */
export const holdSettledAnchor = (list: LegendListRef, rowId: string): (() => void) =>
  keepInView(list, [{ rowId, offset: ANCHOR_OFFSET }]);

/** A key press the browser would turn into a scroll of the focused list. */
export const scrollsList = (event: KeyboardEvent, node: HTMLElement): boolean => {
  if (!isScrollKey(event.key) || event.defaultPrevented) {
    return false;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target === null || !(target === document.body || node.contains(target))) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable]") !== null) {
    return false;
  }
  // Space presses a focused button rather than scrolling past it.
  return !(event.key === " " && target.closest("button, a, [role=button]") !== null);
};

/**
 * Scroll `rowId` to the top and hold it there; returns the cancel. It waits
 * for the list to report the reserve under the row measured (`onReady` of
 * `anchoredEndSpace`) — before that the row cannot reach the top, and an
 * approach aimed at a clamped end would fall short — then eases there unless
 * the reader asked for reduced motion, then holds.
 */
export function placeAnchor({
  list,
  rowId,
  indexOf,
  reserved,
  onPlaced,
}: {
  list: LegendListRef;
  rowId: string;
  indexOf: (rowId: string) => number;
  reserved: { key: string | undefined; waiters: Set<() => void> };
  /** The approach is over and the hold begins. */
  onPlaced: () => void;
}): () => void {
  let disposed = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scrollTo = (animated: boolean) => {
    const index = indexOf(rowId);
    return index < 0
      ? Promise.resolve()
      : list.scrollToIndex({ index, viewPosition: 0, viewOffset: ANCHOR_OFFSET, animated });
  };
  const hold = () => {
    onPlaced();
    const started = performance.now();
    let lastMove = started;
    let geometry = "";
    const step = (now: number) => {
      if (disposed) {
        return;
      }
      const state = list.getState();
      const next = [
        state.positionByKey(rowId),
        state.contentLength,
        state.scrollLength,
        state.scroll,
      ].join(":");
      if (next !== geometry) {
        geometry = next;
        lastMove = now;
        void scrollTo(false);
      }
      if (now - lastMove < HOLD_QUIET_MS && now - started < HOLD_MAX_MS) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
  };
  const approach = () => {
    reserved.waiters.delete(onReserved);
    clearTimeout(timer);
    if (disposed) {
      return;
    }
    if (prefersReducedMotion()) {
      hold();
      return;
    }
    const cap = new Promise((resolve) => {
      timer = setTimeout(resolve, APPROACH_MAX_MS);
    });
    void Promise.race([scrollTo(true), cap]).then(() => {
      if (!disposed) {
        hold();
      }
    });
  };
  const onReserved = () => {
    if (reserved.key === rowId) {
      approach();
    }
  };
  if (reserved.key === rowId) {
    approach();
  } else {
    reserved.waiters.add(onReserved);
    timer = setTimeout(approach, RESERVE_WAIT_MAX_MS);
  }
  return () => {
    disposed = true;
    reserved.waiters.delete(onReserved);
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  };
}
