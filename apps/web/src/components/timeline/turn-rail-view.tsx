/**
 * The turn rail: a slim column of ticks at the timeline's right edge, one per
 * user message (`turn-rail.ts`). Hovering a tick previews the message's first
 * line, pressing it scrolls that message to the top, and the tick of the turn
 * in view is drawn solid. Each tick's accessible name holds the same preview,
 * since a tooltip is visual only.
 *
 * The rail is an overlay over the list with its own size container, so it
 * can hide itself when the timeline is too narrow to keep it clear of the
 * text column; it does not render at all with fewer than two messages. Ticks
 * share the rail's height: each is a 24px target until there are too many to
 * fit, then they shrink together.
 *
 * `useTurnNavigation` owns the scroll for the rail and for the
 * `timeline.previousMessage` / `nextMessage` keys, which work whether or not
 * the rail is on screen. Either one hands the scroll to the reader first
 * (`release`), so a held send anchor lets go instead of pulling the list
 * back.
 *
 * The rail overlays the list without sitting inside its scroller, so a wheel
 * over it would scroll nothing: it passes the wheel on to the list, as the
 * reader's own scroll.
 *
 * The rows are a new array on every streamed delta. The entries are rebuilt
 * only when a message is added or moves (`railKey`), so the rail, a memo,
 * does not rerender and its listeners are not rebuilt while a reply streams.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { useKeybindingCommand } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

import type { TimelineRow } from "./fold";
import {
  activeRailItem,
  type RailDirection,
  type RailItem,
  railItems,
  railKey,
  railTarget,
  rowAtOffset,
  wheelPixels,
} from "./turn-rail";
import { contentScrollTop, prefersReducedMotion } from "./list-hold";

/** Room left above a message the rail scrolls to, in px. Less than the row gap. */
const RAIL_OFFSET = 8;

/**
 * How far below the viewport top the rail looks for the row the reader is on:
 * past the room a jump leaves above a message and the send anchor's 16px, so
 * the message just scrolled to counts rather than the row ending above it.
 */
const TOP_PROBE = 24;

/** Which rows are on screen, as the rail's model reads them. */
interface ViewRows {
  /** The row at the top of the viewport. */
  readonly first: number;
  /** The last row on screen, only while the list sits at its end. */
  readonly endAtEnd: number | undefined;
}

/**
 * The rows on screen. The list's own `start` is only brought up to date when
 * it re-lays its containers, so the rows are read off the scroll offset and
 * the row positions instead; those start below the content's top padding.
 */
const viewRows = (list: LegendListRef): ViewRows => {
  const node = list.getScrollableNode();
  const top = contentScrollTop(list);
  const state = list.getState();
  const rowAt = (offset: number) => rowAtOffset(state.data.length, state.positionAtIndex, offset);
  return {
    first: rowAt(top + TOP_PROBE),
    endAtEnd: state.isAtEnd ? rowAt(top + node.clientHeight - 1) : undefined,
  };
};

/** The message the reader is in, read once a frame while the list scrolls. */
function useActiveRailId(
  listRef: React.RefObject<LegendListRef | null>,
  items: ReadonlyArray<RailItem>,
  enabled: boolean,
): string | undefined {
  const [activeId, setActiveId] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    const list = listRef.current;
    if (!enabled || list === null) {
      return;
    }
    const node = list.getScrollableNode();
    let frame = 0;
    const read = () => {
      frame = 0;
      const rows = viewRows(list);
      setActiveId(activeRailItem(items, rows.first, rows.endAtEnd)?.rowId);
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(read);
      }
    };
    schedule();
    node.addEventListener("scroll", schedule, { passive: true });
    // Rows settling to their measured heights move the positions without a scroll.
    const stopSize = list.getState().listen("totalSize", schedule);
    const stopEnd = list.getState().listen("isAtEnd", schedule);
    return () => {
      node.removeEventListener("scroll", schedule);
      stopSize();
      stopEnd();
      cancelAnimationFrame(frame);
    };
  }, [listRef, items, enabled]);
  return activeId;
}

interface TurnNavigation {
  readonly items: ReadonlyArray<RailItem>;
  readonly goTo: (item: RailItem) => void;
  /** Scroll the list by a wheel that landed on the rail, as the reader's scroll. */
  readonly wheel: (deltaY: number, deltaMode: number) => void;
}

/** The rail's entries, and the scroll both it and the message keys use. */
export function useTurnNavigation({
  listRef,
  rows,
  release,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  rows: ReadonlyArray<TimelineRow>;
  /** Hand the scroll to the reader, as their own scroll would. */
  release: () => void;
}): TurnNavigation {
  const key = React.useMemo(() => railKey(rows), [rows]);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // Keyed by the messages' ids and places, not by the rows array itself.
  const items = React.useMemo(() => (key === "" ? [] : railItems(rowsRef.current)), [key]);
  const goTo = React.useCallback(
    (item: RailItem) => {
      release();
      void listRef.current?.scrollToIndex({
        index: item.rowIndex,
        viewPosition: 0,
        viewOffset: RAIL_OFFSET,
        animated: !prefersReducedMotion(),
      });
    },
    [listRef, release],
  );
  const step = (direction: RailDirection) => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const rows = viewRows(list);
    const target = railTarget(items, rows.first, direction, rows.endAtEnd);
    if (target !== undefined) {
      goTo(target);
    }
  };
  const wheel = React.useCallback(
    (deltaY: number, deltaMode: number) => {
      const list = listRef.current;
      if (list === null || deltaY === 0) {
        return;
      }
      release();
      const node = list.getScrollableNode();
      node.scrollBy({ top: wheelPixels(deltaY, deltaMode, node.clientHeight) });
    },
    [listRef, release],
  );
  useKeybindingCommand("timeline.previousMessage", () => step("previous"));
  useKeybindingCommand("timeline.nextMessage", () => step("next"));
  return React.useMemo(() => ({ items, goTo, wheel }), [items, goTo, wheel]);
}

export const TurnRail = React.memo(function TurnRail({
  listRef,
  navigation,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  navigation: TurnNavigation;
}) {
  const { items, goTo, wheel } = navigation;
  const shown = items.length >= 2;
  const activeId = useActiveRailId(listRef, items, shown);
  if (!shown) {
    return null;
  }
  return (
    <div className="@container/rail pointer-events-none absolute inset-0">
      <nav
        aria-label="Messages in this thread"
        className="absolute inset-y-6 right-3 hidden flex-col justify-center @min-[800px]/rail:flex"
      >
        <ol
          className="pointer-events-auto flex max-h-full min-h-0 flex-col"
          onWheel={(event) => wheel(event.deltaY, event.deltaMode)}
        >
          {items.map((item, index) => {
            const current = item.rowId === activeId;
            return (
              <li key={item.rowId} className="flex min-h-0 basis-6">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        // The preview is the tick's only content, and a
                        // tooltip is not announced: the name carries it.
                        aria-label={`Go to message ${index + 1}: ${item.preview}`}
                        aria-current={current ? "true" : undefined}
                        className="max-h-full"
                        onClick={() => goTo(item)}
                      />
                    }
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-0.5 rounded-full transition-colors",
                        current
                          ? "w-4 bg-foreground"
                          : "w-3 bg-muted-foreground/40 group-hover/button:bg-foreground/70",
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <span className="line-clamp-2 block max-w-64">{item.preview}</span>
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
});
