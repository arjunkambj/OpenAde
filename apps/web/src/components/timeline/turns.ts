/**
 * The grouping `buildTimeline` (`fold.ts`) works from: which items sit at the
 * top level, which turn each belongs to, and where each answered decision
 * lands.
 *
 * - `task` children (rows whose `parentItemId` resolves to a task) leave the
 *   top level and render nested inside the task row via `childrenByParent`.
 *   A parent that is missing or not a task leaves the item at the top level
 *   rather than dropping it.
 * - A `user_message` opens a turn, unless it carries the id of the turn
 *   already open: a message steered into a running turn is part of that turn,
 *   so it stays inside it instead of splitting it in two. Rows without a turn
 *   id (older logs, rows a connector emitted outside any turn) fall back to
 *   position: they belong to the turn the last user message opened. Items
 *   before the first user message (a resumed thread, a system row) form a
 *   leading turn with no opener.
 * - Each decision anchors to the top-level row that holds its `afterItemId`:
 *   a task child's record follows the task. A record with no anchor, or one
 *   that names no item, trails at the end.
 */

import type { ResolvedDecision } from "@OpenAde/contracts/decisions";
import type { TurnId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

export interface Nesting {
  readonly byId: ReadonlyMap<string, ItemSnapshot>;
  readonly roots: ReadonlyArray<ItemSnapshot>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}

export const nestTaskChildren = (items: ReadonlyArray<ItemSnapshot>): Nesting => {
  const byId = new Map<string, ItemSnapshot>();
  for (const item of items) {
    byId.set(item.itemId, item);
  }
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
  return { byId, roots, childrenByParent };
};

export interface Turn {
  /** The turn's top-level items in order, its opener first when it has one. */
  readonly items: ReadonlyArray<ItemSnapshot>;
  /** The user message that opened it; `undefined` for the leading turn. */
  readonly opener: ItemSnapshot | undefined;
  /** The first turn id any of its items carries. */
  readonly turnId: TurnId | undefined;
}

export const groupTurns = (roots: ReadonlyArray<ItemSnapshot>): ReadonlyArray<Turn> => {
  const turns: { items: ItemSnapshot[]; opener: ItemSnapshot | undefined; turnId?: TurnId }[] = [];
  for (const item of roots) {
    const current = turns.at(-1);
    const steered =
      current?.opener !== undefined && item.turnId !== undefined && item.turnId === current.turnId;
    if (item.kind === "user_message" && !steered) {
      turns.push({ items: [item], opener: item, turnId: item.turnId });
    } else if (current === undefined) {
      turns.push({ items: [item], opener: undefined, turnId: item.turnId });
    } else {
      current.items.push(item);
      current.turnId ??= item.turnId;
    }
  }
  return turns.map((turn) => ({ items: turn.items, opener: turn.opener, turnId: turn.turnId }));
};

export interface AnchoredDecisions {
  /** Top-level item id → the records that follow it, oldest first. */
  readonly after: ReadonlyMap<string, ReadonlyArray<ResolvedDecision>>;
  readonly trailing: ReadonlyArray<ResolvedDecision>;
}

export const anchorDecisions = (
  decisions: ReadonlyArray<ResolvedDecision>,
  byId: ReadonlyMap<string, ItemSnapshot>,
): AnchoredDecisions => {
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
  const after = new Map<string, ResolvedDecision[]>();
  const trailing: ResolvedDecision[] = [];
  for (const decision of decisions) {
    const anchor = decision.afterItemId === undefined ? undefined : rootIdOf(decision.afterItemId);
    if (anchor === undefined) {
      trailing.push(decision);
    } else {
      after.set(anchor, [...(after.get(anchor) ?? []), decision]);
    }
  }
  return { after, trailing };
};
