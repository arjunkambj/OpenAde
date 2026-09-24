/**
 * The ids of every disclosure a timeline projection renders, for
 * `timeline.collapseAll` / `timeline.expandAll`. Each id is the `rowId` the
 * row hands `useRowDisclosure`, so writing an override for it opens or closes
 * exactly that row:
 *
 * - item rows of the kinds that render a `DisclosureRow` (or, for a plan, its
 *   own collapsible), keyed by `itemId`;
 * - `turn-fold`, `work-group`, `turn-summary` and `decision` rows, keyed by
 *   their row id;
 * - the items folded inside a work group and the children nested under a task
 *   (`childrenByParent`, at any depth), since those rows render the same
 *   disclosures inside their parent.
 *
 * A closed turn fold leaves its rows out of the projection, so the caller
 * hands this the projection built with every fold open (`ALL_FOLDS_OPEN`):
 * expanding all then opens the folds and the work groups inside them at once.
 *
 * Messages, todos, skills, errors and the working row have nothing to fold.
 */

import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import type { TimelineProjection } from "@/components/timeline/fold";

const DISCLOSURE_KINDS: ReadonlySet<ItemKind> = new Set([
  "reasoning",
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "plan",
]);

export const disclosureIds = (projection: TimelineProjection): ReadonlyArray<string> => {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const visit = (item: ItemSnapshot) => {
    if (seen.has(item.itemId)) {
      return;
    }
    if (DISCLOSURE_KINDS.has(item.kind)) {
      add(item.itemId);
    }
    for (const child of projection.childrenByParent.get(item.itemId) ?? []) {
      visit(child);
    }
  };

  for (const row of projection.rows) {
    switch (row.kind) {
      case "item":
        visit(row.item);
        break;
      case "work-group":
        add(row.id);
        row.items.forEach(visit);
        break;
      case "turn-fold":
      case "turn-summary":
      case "decision":
        add(row.id);
        break;
      case "working":
        break;
    }
  }
  return ids;
};
