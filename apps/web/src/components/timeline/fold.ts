/**
 * Turns a flat `ItemSnapshot[]` into the rows the timeline renders.
 *
 * Items carry no turn id or timestamp, so structure is positional: a
 * `user_message` opens a segment, and the segment that is still open (the last
 * one, while a turn runs) renders its work rows inline. Settled segments fold
 * each maximal run of work kinds into one `work-group` row — the "N tools · 4s"
 * disclosure — and a settled turn that did any work ends with one
 * `turn-summary` row: "Worked for 12s · 3 files +20 −4". Durations come out of
 * the UUIDv7 ids, which carry their creation millisecond in the leading 48
 * bits.
 *
 * `task` children (rows whose `parentItemId` resolves to a task) leave the top
 * level and render nested inside the task row via `childrenByParent`.
 */

import type { ItemKind } from "@OpenAde/contracts/enums";
import type { FileChangeKind, ItemSnapshot } from "@OpenAde/contracts/runtime";
import { uuidV7Millis } from "@OpenAde/shared/ids";

import { diffStats } from "@/lib/diff-stats";

export interface TimelineItemRow {
  readonly kind: "item";
  readonly id: string;
  readonly item: ItemSnapshot;
}

/** One folded run of work rows inside a settled turn. */
export interface TimelineWorkGroupRow {
  readonly kind: "work-group";
  readonly id: string;
  readonly items: ReadonlyArray<ItemSnapshot>;
  /** Rows that did something observable — reasoning folds but does not count. */
  readonly toolCount: number;
  readonly failedCount: number;
  readonly durationMs: number | undefined;
}

/** One changed path in a turn summary, its diffs summed across the turn. */
export interface TurnSummaryFile {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly added: number;
  readonly removed: number;
}

/** The closing line of a settled turn that did work: time taken, files touched. */
export interface TimelineTurnSummaryRow {
  readonly kind: "turn-summary";
  readonly id: string;
  /** First item to last, nested task children included; undefined when 0 or unknown. */
  readonly durationMs: number | undefined;
  readonly files: ReadonlyArray<TurnSummaryFile>;
  readonly added: number;
  readonly removed: number;
  readonly failedCount: number;
}

/** Trailing "Working…" row shown while a turn is open. */
export interface TimelineWorkingRow {
  readonly kind: "working";
  readonly id: string;
}

export type TimelineRow =
  | TimelineItemRow
  | TimelineWorkGroupRow
  | TimelineTurnSummaryRow
  | TimelineWorkingRow;

export interface TimelineProjection {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}

/** Work kinds: they narrate process, not content, so they fold when settled. */
const FOLDABLE_KINDS: ReadonlySet<ItemKind> = new Set([
  "reasoning",
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "skill",
]);

/** Foldable kinds that count as tools in the summary label. */
const TOOL_KINDS: ReadonlySet<ItemKind> = new Set([
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "skill",
]);

const workGroupRow = (items: ReadonlyArray<ItemSnapshot>): TimelineWorkGroupRow => {
  const firstMs = uuidV7Millis(items[0].itemId);
  const lastMs = uuidV7Millis(items[items.length - 1].itemId);
  const durationMs =
    firstMs !== undefined && lastMs !== undefined ? Math.max(0, lastMs - firstMs) : undefined;
  let toolCount = 0;
  let failedCount = 0;
  for (const item of items) {
    if (TOOL_KINDS.has(item.kind)) {
      toolCount += 1;
    }
    if (item.status === "failed") {
      failedCount += 1;
    }
  }
  return {
    kind: "work-group",
    id: `work-group:${items[0].itemId}`,
    items,
    toolCount,
    failedCount,
    durationMs,
  };
};

/**
 * A path touched twice keeps the kind that describes the turn's net effect:
 * a file the turn created and then edited is still new; anything else takes
 * the latest kind.
 */
const mergeKind = (earlier: FileChangeKind, later: FileChangeKind): FileChangeKind =>
  earlier === "create" && later === "edit" ? "create" : later;

const turnSummaryRow = (
  segment: ReadonlyArray<ItemSnapshot>,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>,
): TimelineTurnSummaryRow => {
  // Every item the turn produced, task children (at any depth) included.
  const all: ItemSnapshot[] = [];
  const visit = (item: ItemSnapshot) => {
    all.push(item);
    for (const child of childrenByParent.get(item.itemId) ?? []) {
      visit(child);
    }
  };
  segment.forEach(visit);

  const files = new Map<string, TurnSummaryFile>();
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  let failedCount = 0;
  for (const item of all) {
    const ms = uuidV7Millis(item.itemId);
    if (ms !== undefined) {
      firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
      lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    }
    if (item.status === "failed") {
      failedCount += 1;
    }
    const change = item.kind === "file_change" ? item.fileChange : undefined;
    if (change !== undefined) {
      const stats = change.diff === undefined ? { added: 0, removed: 0 } : diffStats(change.diff);
      const seen = files.get(change.path);
      files.set(change.path, {
        path: change.path,
        kind: seen === undefined ? change.kind : mergeKind(seen.kind, change.kind),
        added: (seen?.added ?? 0) + stats.added,
        removed: (seen?.removed ?? 0) + stats.removed,
      });
    }
  }

  const list = [...files.values()];
  const durationMs =
    firstMs !== undefined && lastMs !== undefined && lastMs > firstMs
      ? lastMs - firstMs
      : undefined;
  return {
    kind: "turn-summary",
    id: `turn-summary:${segment[0].itemId}`,
    durationMs,
    files: list,
    added: list.reduce((sum, file) => sum + file.added, 0),
    removed: list.reduce((sum, file) => sum + file.removed, 0),
    failedCount,
  };
};

export const buildTimeline = (
  items: ReadonlyArray<ItemSnapshot>,
  options: { readonly turnActive: boolean },
): TimelineProjection => {
  const byId = new Map<string, ItemSnapshot>();
  for (const item of items) {
    byId.set(item.itemId, item);
  }

  // Children of tasks nest under their parent; a parent that is missing or not
  // a task leaves the item at top level rather than dropping it.
  const childrenByParent = new Map<string, ItemSnapshot[]>();
  const roots: ItemSnapshot[] = [];
  for (const item of items) {
    const parent = item.parentItemId === undefined ? undefined : byId.get(item.parentItemId);
    if (parent?.kind === "task") {
      const siblings = childrenByParent.get(parent.itemId) ?? [];
      siblings.push(item);
      childrenByParent.set(parent.itemId, siblings);
    } else {
      roots.push(item);
    }
  }

  // Segments: a user message starts a new one; items before the first message
  // (a resumed thread, a system row) form a leading segment of their own.
  const segments: ItemSnapshot[][] = [];
  for (const item of roots) {
    if (item.kind === "user_message" || segments.length === 0) {
      segments.push([item]);
    } else {
      segments[segments.length - 1].push(item);
    }
  }

  const rows: TimelineRow[] = [];
  const lastSegment = segments.length - 1;

  segments.forEach((segment, index) => {
    const live = options.turnActive && index === lastSegment;
    if (live) {
      for (const item of segment) {
        rows.push({ kind: "item", id: item.itemId, item });
      }
      return;
    }

    let run: ItemSnapshot[] = [];
    let worked = false;
    const flush = () => {
      if (run.length > 0) {
        rows.push(workGroupRow(run));
        run = [];
      }
    };
    for (const item of segment) {
      if (FOLDABLE_KINDS.has(item.kind)) {
        run.push(item);
        worked = true;
      } else {
        flush();
        rows.push({ kind: "item", id: item.itemId, item });
      }
    }
    flush();

    // Only a turn — a segment the user opened — gets a closing line, and only
    // when it did work: a plain exchange needs no "Worked for".
    if (worked && segment[0].kind === "user_message") {
      rows.push(turnSummaryRow(segment, childrenByParent));
    }
  });

  if (options.turnActive) {
    rows.push({ kind: "working", id: "working" });
  }

  return { rows, childrenByParent };
};
