/**
 * The measurements the browser host lays its webviews out from: the pane
 * slot's rect, the viewport, and the last rect the pane had on screen.
 */
import * as React from "react";

import { visibleRect, type Rect, type Size } from "./host-geometry";

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

const measure = (element: HTMLElement): Rect => {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
};

/**
 * The element's rect in the viewport, kept current by a `ResizeObserver` on
 * it, the window's `resize`, and any scroll (captured, so a scrolling
 * ancestor counts too). `null` while there is no element.
 */
export const useElementRect = (element: HTMLElement | null): Rect | null => {
  const [rect, setRect] = React.useState<Rect | null>(null);
  React.useLayoutEffect(() => {
    if (element === null) {
      setRect(null);
      return;
    }
    let frame = 0;
    const update = () => {
      const next = measure(element);
      setRect((current) => (sameRect(current, next) ? current : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [element]);
  return rect;
};

const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

export const useViewport = (): Size => {
  const [size, setSize] = React.useState<Size>(viewportSize);
  React.useEffect(() => {
    const update = () =>
      setSize((current) => {
        const next = viewportSize();
        return current.width === next.width && current.height === next.height ? current : next;
      });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
};

/** The last rect the slot had with some area, or `null` if it never had one. */
export const useLastPaneRect = (slotRect: Rect | null): Rect | null => {
  const [last, setLast] = React.useState<Rect | null>(null);
  const shown = visibleRect(slotRect);
  React.useEffect(() => {
    if (shown !== null) setLast((current) => (sameRect(current, shown) ? current : shown));
  }, [shown]);
  return shown ?? last;
};
