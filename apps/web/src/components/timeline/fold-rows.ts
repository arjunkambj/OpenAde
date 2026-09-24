/**
 * The rows `buildTimeline` (`fold.ts`) makes out of a settled turn's items:
 * the `work-group` fold over a run of work, and the `turn-summary` that closes
 * a turn — plus the span of time a turn's items cover, which the summary and
 * the final answer's footer both report.
 *
 * Durations come out of the UUIDv7 ids, which carry their creation
 * millisecond in the leading 48 bits.
 */

import type { ItemKind } from "@OpenAde/contracts/enums";
import type { FileChangeKind, ItemSnapshot } from "@OpenAde/contracts/runtime";
import { uuidV7Millis } from "@OpenAde/shared/ids";

import { countFailed, mergeKind } from "@/components/timeline/work-summary";
import { diffStats } from "@/lib/diff-stats";

/** One folded run of work rows. Its label is `workGroupLabel` over `items`. */
export interface TimelineWorkGroupRow {
  readonly kind: "work-group";
  readonly id: string;
  readonly items: ReadonlyArray<ItemSnapshot>;
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
  /** The ref of the checkpoint the turn left, for the Changes pane; undefined when it has none. */
  readonly checkpointRef: string | undefined;
}

/** Work kinds: they narrate process, not content, so they fold when settled. */
export const FOLDABLE_KINDS: ReadonlySet<ItemKind> = new Set([
  "reasoning",
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "skill",
]);

export const workGroupRow = (items: ReadonlyArray<ItemSnapshot>): TimelineWorkGroupRow => {
  const firstMs = uuidV7Millis(items[0].itemId);
  const lastMs = uuidV7Millis(items[items.length - 1].itemId);
  const durationMs =
    firstMs !== undefined && lastMs !== undefined ? Math.max(0, lastMs - firstMs) : undefined;
  return {
    kind: "work-group",
    id: `work-group:${items[0].itemId}`,
    items,
    failedCount: countFailed(items),
    durationMs,
  };
};

/** Every item under `roots`, task children at any depth included. */
export const withChildren = (
  roots: ReadonlyArray<ItemSnapshot>,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>,
): ReadonlyArray<ItemSnapshot> => {
  const all: ItemSnapshot[] = [];
  const visit = (item: ItemSnapshot) => {
    all.push(item);
    for (const child of childrenByParent.get(item.itemId) ?? []) {
      visit(child);
    }
  };
  roots.forEach(visit);
  return all;
};

/** Earliest item to latest; undefined when the ids carry no time or no span. */
export const spanMs = (items: ReadonlyArray<ItemSnapshot>): number | undefined => {
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const item of items) {
    const ms = uuidV7Millis(item.itemId);
    if (ms !== undefined) {
      firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
      lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    }
  }
  return firstMs !== undefined && lastMs !== undefined && lastMs > firstMs
    ? lastMs - firstMs
    : undefined;
};

export const turnSummaryRow = (
  segment: ReadonlyArray<ItemSnapshot>,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>,
  checkpointRefByTurn: ReadonlyMap<string, string>,
): TimelineTurnSummaryRow => {
  const all = withChildren(segment, childrenByParent);
  const files = new Map<string, TurnSummaryFile>();
  let failedCount = 0;
  for (const item of all) {
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
  const turnId = all.find((item) => item.turnId !== undefined)?.turnId;
  return {
    kind: "turn-summary",
    id: `turn-summary:${segment[0].itemId}`,
    durationMs: spanMs(all),
    files: list,
    added: list.reduce((sum, file) => sum + file.added, 0),
    removed: list.reduce((sum, file) => sum + file.removed, 0),
    failedCount,
    checkpointRef: turnId === undefined ? undefined : checkpointRefByTurn.get(turnId),
  };
};
