import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "vitest";

import { buildTimeline, type TimelineWorkGroupRow } from "./fold";

let sequence = 0;

/** A deterministic UUIDv7 with a controllable millisecond prefix. */
const itemIdAt = (millis: number): ItemId => {
  sequence += 1;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
};

let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  millis += 1_000;
  return { itemId: itemIdAt(millis), kind, status: "completed", ...over };
};

const workGroups = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineWorkGroupRow => row.kind === "work-group");

describe("buildTimeline", () => {
  it("passes a lone message exchange through untouched", () => {
    const items = [
      item("user_message", { text: "hi" }),
      item("assistant_message", { text: "hello" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
  });

  it("folds a settled turn's tool run into one work group", () => {
    const items = [
      item("user_message"),
      item("reasoning"),
      item("tool_call"),
      item("command_execution"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["item", "work-group", "item"]);
    const group = workGroups(rows)[0];
    expect(group.items).toHaveLength(3);
    // reasoning folds but is not a tool
    expect(group.toolCount).toBe(2);
  });

  it("keeps the live segment unfolded and appends a working row", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("tool_call"),
    ];
    const { rows } = buildTimeline(items, { turnActive: true });
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "work-group",
      "item",
      "item",
      "item",
      "working",
    ]);
  });

  it("splits a settled run around a non-foldable row", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("context_compaction"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "work-group",
      "item",
      "work-group",
      "item",
    ]);
    const groups = workGroups(rows);
    expect(groups.map((group) => group.toolCount)).toEqual([1, 1]);
  });

  it("nests task children under the parent and keeps orphans at top level", () => {
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const orphan = item("tool_call", { parentItemId: itemIdAt(1) });
    const { rows, childrenByParent } = buildTimeline([task, child, orphan], {
      turnActive: false,
    });
    expect(childrenByParent.get(task.itemId)?.map((i) => i.itemId)).toEqual([child.itemId]);
    // task and orphan form one settled run; the child is not a top-level row
    expect(rows).toHaveLength(1);
    expect(workGroups(rows)[0].items.map((i) => i.itemId)).toEqual([task.itemId, orphan.itemId]);
  });

  it("derives the group's duration from the UUIDv7 item ids", () => {
    const items = [item("user_message"), item("tool_call"), item("tool_call")];
    const group = workGroups(buildTimeline(items, { turnActive: false }).rows)[0];
    expect(group.durationMs).toBe(1_000);
  });

  it("reports failures in the folded group", () => {
    const items = [
      item("user_message"),
      item("command_execution", { status: "failed" }),
      item("tool_call"),
    ];
    const group = workGroups(buildTimeline(items, { turnActive: false }).rows)[0];
    expect(group.failedCount).toBe(1);
  });

  it("folds items that precede the first user message", () => {
    const items = [item("reasoning"), item("tool_call"), item("assistant_message")];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["work-group", "item"]);
  });
});
