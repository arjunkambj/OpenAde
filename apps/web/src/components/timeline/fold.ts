/**
 * Turns a flat `ItemSnapshot[]` into the rows the timeline renders.
 *
 * Structure is positional: a `user_message` opens a segment, and the segment
 * that is still open (the last one, while a turn runs) renders its work rows
 * inline. Settled segments fold each maximal run of work kinds into one
 * `work-group` row — the "N tools · 4s" disclosure — and a settled turn that
 * did any work ends with one `turn-summary` row: "Worked for 12s · 3 files
 * +20 −4" (both built in `fold-rows.ts`). Durations come out of the UUIDv7
 * ids, which carry their creation millisecond in the leading 48 bits.
 *
 * `task` children (rows whose `parentItemId` resolves to a task) leave the top
 * level and render nested inside the task row via `childrenByParent`.
 *
 * A turn summary names the checkpoint its turn left behind, when there is one:
 * the turn id of the segment's first row that carries one, looked up in the
 * thread's checkpoints — so its "Open in Changes" can show that very turn.
 *
 * Answered approvals, questions and plans come in as `ResolvedDecision`s and
 * land as one `decision` row right after the row holding their `afterItemId` —
 * a work group ends there, so the record sits between what came before the
 * answer and what came after it. A record with no anchor, or one that names no
 * item, goes at the end.
 */

import type { ResolvedDecision } from "@OpenAde/contracts/decisions";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { uuidV7Millis } from "@OpenAde/shared/ids";

import {
  FOLDABLE_KINDS,
  type TimelineTurnSummaryRow,
  type TimelineWorkGroupRow,
  turnSummaryRow,
  workGroupRow,
} from "./fold-rows";

export type { TimelineTurnSummaryRow, TimelineWorkGroupRow, TurnSummaryFile } from "./fold-rows";

export interface TimelineItemRow {
  readonly kind: "item";
  readonly id: string;
  readonly item: ItemSnapshot;
}

/** The one-line record of an answered approval, question or plan. */
export interface TimelineDecisionRow {
  readonly kind: "decision";
  readonly id: string;
  readonly decision: ResolvedDecision;
}

/** Trailing "Working…" row shown while a turn is open. */
export interface TimelineWorkingRow {
  readonly kind: "working";
  readonly id: string;
  /** Epoch ms the running turn began, for its elapsed clock; undefined when unknown. */
  readonly startedAt: number | undefined;
}

export type TimelineRow =
  | TimelineItemRow
  | TimelineWorkGroupRow
  | TimelineTurnSummaryRow
  | TimelineDecisionRow
  | TimelineWorkingRow;

export interface TimelineProjection {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}

export interface BuildTimelineOptions {
  readonly turnActive: boolean;
  /**
   * When the running turn began, if known — the caller reads it off the turn
   * id. Without it the working row falls back to the last user message, since
   * a turn counts as in flight before its id is filled in.
   */
  readonly turnStartedAt?: number | undefined;
  /** The thread's answered decisions, oldest first (`snapshot.decisions`). */
  readonly decisions?: ReadonlyArray<ResolvedDecision> | undefined;
  /** The thread's checkpoints (`snapshot.checkpoints`), for the turn summaries' links. */
  readonly checkpoints?:
    | ReadonlyArray<{ readonly turnId: string; readonly ref: string }>
    | undefined;
}

/** The start of the running turn: the given time, else the last user message's id. */
const workingStartedAt = (
  roots: ReadonlyArray<ItemSnapshot>,
  turnStartedAt: number | undefined,
): number | undefined => {
  if (turnStartedAt !== undefined) {
    return turnStartedAt;
  }
  const lastMessage = roots.findLast((item) => item.kind === "user_message");
  return lastMessage === undefined ? undefined : uuidV7Millis(lastMessage.itemId);
};

export const buildTimeline = (
  items: ReadonlyArray<ItemSnapshot>,
  options: BuildTimelineOptions,
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

  // Each decision anchors to the top-level row that holds its item: a task
  // child's record follows the task. Unknown anchors fall through to the end.
  const rootIdOf = (itemId: string): string | undefined => {
    let current = byId.get(itemId);
    for (let depth = 0; current !== undefined && depth < byId.size; depth += 1) {
      const parent =
        current.parentItemId === undefined ? undefined : byId.get(current.parentItemId);
      if (parent?.kind !== "task") {
        return current.itemId;
      }
      current = parent;
    }
    return undefined;
  };
  const decisionsAfter = new Map<string, ResolvedDecision[]>();
  const trailing: ResolvedDecision[] = [];
  for (const decision of options.decisions ?? []) {
    const anchor = decision.afterItemId === undefined ? undefined : rootIdOf(decision.afterItemId);
    if (anchor === undefined) {
      trailing.push(decision);
    } else {
      decisionsAfter.set(anchor, [...(decisionsAfter.get(anchor) ?? []), decision]);
    }
  }
  // Row ids must be unique for the list; a repeated id (a plan revised twice
  // in one turn) takes a counter.
  const usedDecisionIds = new Set<string>();
  const decisionRow = (decision: ResolvedDecision): TimelineDecisionRow => {
    let id = `decision:${decision.id}`;
    for (let n = 2; usedDecisionIds.has(id); n += 1) {
      id = `decision:${decision.id}:${n}`;
    }
    usedDecisionIds.add(id);
    return { kind: "decision", id, decision };
  };

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

  const checkpointRefByTurn = new Map<string, string>(
    (options.checkpoints ?? []).map((checkpoint) => [checkpoint.turnId, checkpoint.ref]),
  );

  const rows: TimelineRow[] = [];
  const lastSegment = segments.length - 1;
  const pushDecisions = (decisions: ReadonlyArray<ResolvedDecision> | undefined) => {
    for (const decision of decisions ?? []) {
      rows.push(decisionRow(decision));
    }
  };

  segments.forEach((segment, index) => {
    const live = options.turnActive && index === lastSegment;
    if (live) {
      for (const item of segment) {
        rows.push({ kind: "item", id: item.itemId, item });
        pushDecisions(decisionsAfter.get(item.itemId));
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
      const after = decisionsAfter.get(item.itemId);
      if (FOLDABLE_KINDS.has(item.kind)) {
        run.push(item);
        worked = true;
        // A decision is not work: it closes the run, and the next one starts fresh.
        if (after !== undefined) {
          flush();
        }
      } else {
        flush();
        rows.push({ kind: "item", id: item.itemId, item });
      }
      pushDecisions(after);
    }
    flush();

    // Only a turn — a segment the user opened — gets a closing line, and only
    // when it did work: a plain exchange needs no "Worked for".
    if (worked && segment[0].kind === "user_message") {
      rows.push(turnSummaryRow(segment, childrenByParent, checkpointRefByTurn));
    }
  });

  pushDecisions(trailing);

  if (options.turnActive) {
    rows.push({
      kind: "working",
      id: "working",
      startedAt: workingStartedAt(roots, options.turnStartedAt),
    });
  }

  return { rows, childrenByParent };
};
