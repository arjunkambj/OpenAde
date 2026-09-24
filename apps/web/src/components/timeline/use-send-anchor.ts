/**
 * Feeds `sendAnchorReducer` from the timeline and turns its state into what
 * `LegendList` takes: `maintainScrollAtEnd`, and `anchoredEndSpace` on the
 * last sent message so it can reach the top of the viewport.
 *
 * On a send the message is scrolled to `ANCHOR_OFFSET` below the top — eased
 * unless the reader asked for reduced motion — and then held. Rows above it
 * settle from estimated to measured heights for a few hundred milliseconds
 * after a send, and the reserve under it catches up a frame late, so one
 * scroll would land wrong: the hold re-places the row without animation on
 * every frame the geometry moves, until it has been still for `HOLD_QUIET_MS`.
 *
 * The reader takes the scroll back with any wheel, touch drag, scrolling key
 * in the list, press on its scrollbar, or text selection inside it. The
 * list's own scrolls are not events here, so the hold never releases itself.
 * The intent stops the hold on the spot, before the dispatch: a wheel's
 * render is not urgent, and a frame of the hold between the reader's scroll
 * and that render would read the scroll as the list moving and put the
 * message back, undoing the reader's first tick.
 *
 * Expand-all and collapse-all go through `beforeFoldAll`: the list's own
 * data-change scroll anchoring is off, so rows opening or closing above the
 * viewport would move what the reader sees. Unless the list follows at its
 * end, the row they were on is held where it sat (`keepInView`), the same way
 * the send hold does, and the reader's scroll stops that hold too.
 */

import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { sentHereRecently } from "@/state/local-sends";

import type { TimelineRow } from "./fold";
import {
  bulkFoldKeepsEnd,
  foldsOpened,
  INITIAL_SEND_ANCHOR,
  isScrollKey,
  pickViewAnchor,
  rowIdSet,
  sendAnchorProps,
  sendAnchorReducer,
  sentUserMessageId,
  type SendAnchorEvent,
  type SendAnchorState,
  type ViewAnchor,
  viewAnchors,
} from "./send-anchor";

/** Distance from the viewport top to the held message, in px. */
const ANCHOR_OFFSET = 16;
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
const currentViewAnchors = (list: LegendListRef): ReadonlyArray<ViewAnchor> => {
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

type Action = SendAnchorEvent | { readonly type: "reset" };

const reduce = (state: SendAnchorState, action: Action): SendAnchorState =>
  action.type === "reset" ? INITIAL_SEND_ANCHOR : sendAnchorReducer(state, action);

/** A key press the browser would turn into a scroll of the focused list. */
const scrollsList = (event: KeyboardEvent, node: HTMLElement): boolean => {
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

export interface SendAnchor {
  readonly maintainScrollAtEnd: boolean;
  readonly anchoredEndSpace:
    | {
        readonly anchorIndex: number;
        readonly anchorOffset: number;
        readonly onReady: (info: { anchorKey: string | undefined }) => void;
      }
    | undefined;
  /** A sent message is on its way to the top: the list is briefly away from its end. */
  readonly placing: boolean;
  /** Scroll to the end and follow again: the jump button and `timeline.jumpToLatest`. */
  readonly jumpToLatest: () => void;
  /** Hand the scroll to the reader, as their own scroll would: the turn rail and its keys. */
  readonly release: () => void;
  /** Call right before expand-all or collapse-all writes the folds. */
  readonly beforeFoldAll: () => void;
}

export function useSendAnchor({
  listRef,
  rows,
  openFolds,
  threadId,
  turnActive,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  rows: ReadonlyArray<TimelineRow>;
  /** The open turn folds the rows were built with. */
  openFolds: ReadonlySet<string>;
  threadId: string;
  turnActive: boolean;
}): SendAnchor {
  const [state, dispatch] = React.useReducer(reduce, INITIAL_SEND_ANCHOR);
  const modeRef = React.useRef(state.mode);
  modeRef.current = state.mode;
  // Expand-all or collapse-all on its way: the folds it was taken against, and
  // the rows to hold in view, or null when the list follows its end.
  const bulkFolds = React.useRef<{
    readonly from: ReadonlySet<string>;
    readonly anchors: ReadonlyArray<ViewAnchor> | null;
  } | null>(null);
  // A fold that opens hands the scroll to the reader in the same render that
  // brings its rows, before the list sees them with `maintainScrollAtEnd`
  // still on and scrolls them up past the toggle. Expand-all is not the
  // reader opening one fold under their eyes, and keeps the mode.
  const [seenFolds, setSeenFolds] = React.useState(openFolds);
  if (seenFolds !== openFolds) {
    setSeenFolds(openFolds);
    if (bulkFolds.current?.from !== seenFolds && foldsOpened(seenFolds, openFolds)) {
      dispatch({ type: "rowsOpened" });
    }
  }
  const props = sendAnchorProps(state);
  // Cancel the placement running now, and a bulk fold change's hold, if any;
  // called before a release is dispatched.
  const stopPlacement = React.useRef<() => void>(() => {});
  const stopKeep = React.useRef<() => void>(() => {});
  const stopHold = React.useRef(() => {
    stopPlacement.current();
    stopKeep.current();
  });

  // Rows seen so far; null until the first projection of this thread.
  const seen = React.useRef<{ threadId: string; ids: ReadonlySet<string> } | null>(null);
  const wasActive = React.useRef(turnActive);
  // A layout effect, so the reserve and the follow flag change before paint.
  React.useLayoutEffect(() => {
    if (seen.current !== null && seen.current.threadId !== threadId) {
      seen.current = null;
      dispatch({ type: "reset" });
    }
    const newUserMessageId = sentUserMessageId(seen.current?.ids ?? null, rows) ?? undefined;
    seen.current = { threadId, ids: rowIdSet(rows) };
    dispatch({
      type: "rowsChanged",
      newUserMessageId,
      turnActive,
      sentHere: newUserMessageId !== undefined && sentHereRecently(threadId),
      // Read after the list took the new rows: at its end it has followed
      // them, away from it the flag is where the reader left it.
      awayFromEnd:
        newUserMessageId !== undefined && listRef.current?.getState().isNearEnd === false,
    });
    if (wasActive.current && !turnActive) {
      dispatch({ type: "turnSettled" });
    }
    wasActive.current = turnActive;
  }, [listRef, rows, threadId, turnActive]);

  // The reader's own scrolling, and the list reaching its end.
  React.useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const node = list.getScrollableNode();
    const intent = () => {
      stopHold.current();
      dispatch({ type: "userScrollIntent" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (scrollsList(event, node)) {
        intent();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // Only a press on the scrollbar, which sits outside the client box.
      if (event.target === node && event.offsetX >= node.clientWidth) {
        intent();
      }
    };
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed && node.contains(selection.focusNode)) {
        intent();
      }
    };
    node.addEventListener("wheel", intent, { passive: true });
    node.addEventListener("touchmove", intent, { passive: true });
    node.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    const stopListening = list.getState().listen("isAtEnd", (atEnd) => {
      if (atEnd) {
        dispatch({ type: "reachedEnd" });
      }
    });
    return () => {
      node.removeEventListener("wheel", intent);
      node.removeEventListener("touchmove", intent);
      node.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
      stopListening();
    };
  }, [listRef]);

  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // The row whose reserve the list last reported measured, and who waits on it.
  const reserved = React.useRef<{ key: string | undefined; waiters: Set<() => void> }>({
    key: undefined,
    waiters: new Set(),
  });
  const onReserveReady = React.useCallback((info: { anchorKey: string | undefined }) => {
    reserved.current.key = info.anchorKey;
    for (const waiter of reserved.current.waiters) {
      waiter();
    }
  }, []);

  const anchorRowId = props.anchorRowId;
  const [placed, setPlaced] = React.useState(INITIAL_SEND_ANCHOR.placement);
  const placement = state.placement;
  // Place the anchored row, then hold it until the list stops moving under it.
  React.useEffect(() => {
    const list = listRef.current;
    if (anchorRowId === null || list === null) {
      return;
    }
    const cancel = placeAnchor({
      list,
      rowId: anchorRowId,
      indexOf: (rowId) => rowsRef.current.findIndex((row) => row.id === rowId),
      reserved: reserved.current,
      onPlaced: () => setPlaced(placement),
    });
    stopPlacement.current = cancel;
    return () => {
      cancel();
      if (stopPlacement.current === cancel) {
        stopPlacement.current = () => {};
      }
    };
  }, [listRef, anchorRowId, placement]);

  const openFoldsRef = React.useRef(openFolds);
  openFoldsRef.current = openFolds;
  const beforeFoldAll = React.useCallback(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const keepsEnd = bulkFoldKeepsEnd(
      modeRef.current,
      list.getState().isWithinMaintainScrollAtEndThreshold,
    );
    const pending = {
      from: openFoldsRef.current,
      anchors: keepsEnd ? null : currentViewAnchors(list),
    };
    bulkFolds.current = pending;
    // Every fold already as asked: nothing renders, and a later toggle of the
    // reader's own must not pass for this.
    requestAnimationFrame(() => {
      if (bulkFolds.current === pending) {
        bulkFolds.current = null;
      }
    });
  }, [listRef]);
  // After the list took the rows the bulk change brought or removed, and
  // before paint, put the reader's row back where it sat.
  React.useLayoutEffect(() => {
    const pending = bulkFolds.current;
    const list = listRef.current;
    if (pending === null || pending.from === openFolds) {
      return;
    }
    bulkFolds.current = null;
    if (pending.anchors === null || list === null) {
      return;
    }
    stopKeep.current();
    stopKeep.current = keepInView(list, pending.anchors);
  }, [listRef, openFolds]);
  React.useEffect(() => () => stopKeep.current(), []);

  const reserveIndex =
    props.reserveRowId === null ? -1 : rows.findIndex((row) => row.id === props.reserveRowId);
  const jumpToLatest = React.useCallback(() => {
    dispatch({ type: "jumpToLatest" });
    void listRef.current?.scrollToEnd({ animated: !prefersReducedMotion() });
  }, [listRef]);
  const release = React.useCallback(() => {
    stopHold.current();
    dispatch({ type: "userScrollIntent" });
  }, []);

  return {
    maintainScrollAtEnd: props.maintainScrollAtEnd,
    anchoredEndSpace:
      reserveIndex < 0
        ? undefined
        : { anchorIndex: reserveIndex, anchorOffset: ANCHOR_OFFSET, onReady: onReserveReady },
    placing: anchorRowId !== null && placed !== placement,
    jumpToLatest,
    release,
    beforeFoldAll,
  };
}
