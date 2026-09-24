/**
 * Which settled turns' folds are open. A turn fold does not open a body: it
 * changes which rows the timeline's projection holds (`buildTimeline`'s
 * `isFoldOpen`), so the timeline itself has to rebuild when one opens.
 *
 * The state is the same row disclosure map every other row uses, so a fold
 * row's toggle and `timeline.expandAll` / `collapseAll` write it the usual
 * way. The timeline reads only the fold slice of it, as one string of the open
 * ids: a string compares by value, so opening a tool row or a work group
 * leaves the timeline alone, and only a fold opening or closing rebuilds it.
 */

import { useAtomValue } from "@effect/atom-react";
import * as React from "react";

import { rowDisclosureAtom } from "@/state/ui";

/** The row id prefix of a `turn-fold` row (`fold-rows.ts`). */
const TURN_FOLD_PREFIX = "turn-fold:";

/** The open turn-fold ids, sorted, one per line: a value, so equal slices are equal. */
export const openFoldKey = (overrides: Readonly<Record<string, boolean>>): string =>
  Object.keys(overrides)
    .filter((rowId) => rowId.startsWith(TURN_FOLD_PREFIX) && overrides[rowId] === true)
    .sort()
    .join("\n");

/** The set of open turn-fold row ids; a new set only when that slice changes. */
export const useOpenTurnFolds = (): ReadonlySet<string> => {
  const key = useAtomValue(rowDisclosureAtom, openFoldKey);
  return React.useMemo(() => new Set(key === "" ? [] : key.split("\n")), [key]);
};
