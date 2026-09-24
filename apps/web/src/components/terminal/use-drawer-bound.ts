/**
 * How tall the terminal drawer may be in the thread column it sits in, kept
 * current as the window, the header or the composer (a multi-line draft)
 * change size.
 *
 * The column's rows that never grow — the header, the composer — are measured
 * rather than named, so the drawer needs nothing from the thread view but its
 * place at the bottom of the column; the one row that grows is the
 * conversation, which the bound keeps at `TIMELINE_HEIGHT_MIN` or more.
 */

import * as React from "react";

import { drawerHeightMax } from "@/state/terminal-ui";

const measure = (drawer: HTMLElement, column: HTMLElement): number => {
  let fixed = 0;
  for (const row of column.children) {
    if (row !== drawer && getComputedStyle(row).flexGrow === "0") {
      fixed += row.getBoundingClientRect().height;
    }
  }
  return drawerHeightMax(column.getBoundingClientRect().height, fixed);
};

/** The bound in px, or null until the drawer has been laid out. */
export function useDrawerBound(drawerRef: React.RefObject<HTMLElement | null>): number | null {
  const [bound, setBound] = React.useState<number | null>(null);
  React.useEffect(() => {
    const drawer = drawerRef.current;
    const column = drawer?.parentElement;
    if (drawer === null || drawer === undefined || column === null || column === undefined) {
      return;
    }
    const update = () => setBound(measure(drawer, column));
    const sizes = new ResizeObserver(update);
    const observeRows = () => {
      sizes.disconnect();
      sizes.observe(column);
      for (const row of column.children) {
        if (row !== drawer) {
          sizes.observe(row);
        }
      }
      update();
    };
    // A row that mounts later (the conversation replacing its loading state,
    // say) is measured from then on too.
    const rows = new MutationObserver(observeRows);
    rows.observe(column, { childList: true });
    observeRows();
    return () => {
      rows.disconnect();
      sizes.disconnect();
    };
  }, [drawerRef]);
  return bound;
}
