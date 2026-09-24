import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./fold";
import {
  activeRailItem,
  neighbour,
  RAIL_PREVIEW_MAX,
  railItems,
  railKey,
  railPreview,
  railTarget,
  rowAtOffset,
  wheelPixels,
} from "./turn-rail";

const row = (
  id: string,
  kind: ItemKind = "assistant_message",
  extra: Partial<ItemSnapshot> = {},
): TimelineRow => ({
  kind: "item",
  id,
  item: { itemId: id as ItemId, kind, status: "completed", ...extra },
});
const user = (id: string, text = `Message ${id}`) => row(id, "user_message", { text });

// 0 lead, 1 u1, 2 a1, 3 fold, 4 u2, 5 a2, 6 u3 (steered), 7 a3, 8 working
const rows: ReadonlyArray<TimelineRow> = [
  row("lead"),
  user("u1"),
  row("a1"),
  { kind: "turn-fold", id: "turn-fold:u2" } as unknown as TimelineRow,
  user("u2"),
  row("a2"),
  user("u3"),
  row("a3"),
  { kind: "working", id: "working", startedAt: undefined },
];
const items = railItems(rows);

describe("railItems", () => {
  it("has one entry per user message, steered ones included, at its row index", () => {
    expect(items.map((item) => [item.rowId, item.rowIndex])).toEqual([
      ["u1", 1],
      ["u2", 4],
      ["u3", 6],
    ]);
    expect(items[0]?.preview).toBe("Message u1");
  });

  it("is empty without user messages", () => {
    expect(railItems([row("a"), row("b", "reasoning")])).toEqual([]);
  });
});

describe("railKey", () => {
  it("names each user message and where it sits", () => {
    expect(railKey(rows)).toBe("u1@1 u2@4 u3@6 ");
    expect(railKey([row("a")])).toBe("");
  });

  it("stays the same while a reply streams, and moves when a message does", () => {
    const streamed = [...rows.slice(0, -1), row("a4", "assistant_message", { text: "more" })];
    expect(railKey(streamed)).toBe(railKey(rows));
    // A fold opening above a message moves it down the list.
    expect(railKey([row("opened"), ...rows])).not.toBe(railKey(rows));
    expect(railKey([...rows, user("u4")])).not.toBe(railKey(rows));
  });
});

describe("wheelPixels", () => {
  it("reads pixels as they are, lines as 16px, and pages as the list's height", () => {
    expect(wheelPixels(40, 0, 600)).toBe(40);
    expect(wheelPixels(-3, 1, 600)).toBe(-48);
    expect(wheelPixels(1, 2, 600)).toBe(600);
  });
});

describe("railPreview", () => {
  const preview = (text: string) => railPreview({ text });

  it("takes the first non-empty line", () => {
    expect(preview("\n\n  Fix the build  \nthen push")).toBe("Fix the build");
    expect(preview("one\r\ntwo")).toBe("one");
  });

  it("strips markdown marks", () => {
    expect(preview("## Plan for **today**")).toBe("Plan for today");
    expect(preview("> quoted `code` here")).toBe("quoted code here");
    expect(preview("- [ ] a task")).toBe("a task");
    expect(preview("1. first *step*")).toBe("first step");
    expect(preview("See [the docs](https://example.com) and ![shot](a.png)")).toBe(
      "See the docs and shot",
    );
    expect(preview("keep snake_case_names and 2 * 3")).toBe("keep snake_case_names and 2 * 3");
  });

  it("skips fence lines and blank markup", () => {
    expect(preview("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(preview("#\n\nreal text")).toBe("real text");
  });

  it("cuts a long line with an ellipsis", () => {
    const long = "word ".repeat(40);
    const cut = preview(long);
    expect(cut.length).toBeLessThanOrEqual(RAIL_PREVIEW_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(railPreview({ text: "abcdefghij" }, 5)).toBe("abcd…");
    expect(railPreview({ text: "abcde" }, 5)).toBe("abcde");
  });

  it("names what a message without text carried", () => {
    const attachment = { path: "a.png" } as NonNullable<ItemSnapshot["attachments"]>[number];
    expect(railPreview({ text: "", attachments: [attachment] })).toBe("1 attachment");
    expect(railPreview({ attachments: [attachment, attachment] })).toBe("2 attachments");
    expect(railPreview({ text: "  \n" })).toBe("Empty message");
  });
});

describe("rowAtOffset", () => {
  const tops = [0, 102, 142, 399, 563, 973];
  const at = (offset: number) => rowAtOffset(tops.length, (index) => tops[index], offset);

  it("finds the row whose top is at or above the offset", () => {
    expect(at(0)).toBe(0);
    expect(at(101)).toBe(0);
    expect(at(102)).toBe(1);
    expect(at(570)).toBe(4);
    expect(at(5000)).toBe(5);
  });

  it("is -1 above the first row and for an empty list", () => {
    expect(at(-24)).toBe(-1);
    expect(rowAtOffset(0, () => 0, 100)).toBe(-1);
  });

  it("treats an unknown position as further down", () => {
    expect(rowAtOffset(4, (index) => (index < 2 ? index * 100 : undefined), 1000)).toBe(1);
  });
});

describe("activeRailItem", () => {
  it("is the last message at or above the first visible row", () => {
    expect(activeRailItem(items, 1)?.rowId).toBe("u1");
    expect(activeRailItem(items, 3)?.rowId).toBe("u1");
    expect(activeRailItem(items, 4)?.rowId).toBe("u2");
    expect(activeRailItem(items, 8)?.rowId).toBe("u3");
  });

  it("is the last message on screen at the end of the list", () => {
    // The top row is turn 2's answer, and the short last turn sits below it.
    expect(activeRailItem(items, 5, 8)?.rowId).toBe("u3");
    expect(activeRailItem(items, 2, 3)?.rowId).toBe("u1");
  });

  it("is undefined above the first message and before the list reports a range", () => {
    expect(activeRailItem(items, 0)).toBeUndefined();
    expect(activeRailItem(items, -1)).toBeUndefined();
    expect(activeRailItem([], 5)).toBeUndefined();
  });
});

describe("neighbour", () => {
  it("steps both ways and stops at the ends", () => {
    expect(neighbour(items, "u2", "previous")?.rowId).toBe("u1");
    expect(neighbour(items, "u2", "next")?.rowId).toBe("u3");
    expect(neighbour(items, "u1", "previous")).toBeUndefined();
    expect(neighbour(items, "u3", "next")).toBeUndefined();
  });

  it("goes to the first message from above it, and nowhere from an unknown id", () => {
    expect(neighbour(items, undefined, "next")?.rowId).toBe("u1");
    expect(neighbour(items, undefined, "previous")).toBeUndefined();
    expect(neighbour(items, "gone", "next")).toBeUndefined();
    expect(neighbour([], undefined, "next")).toBeUndefined();
  });
});

describe("railTarget", () => {
  it("steps from a message at the top", () => {
    expect(railTarget(items, 4, "previous")?.rowId).toBe("u1");
    expect(railTarget(items, 4, "next")?.rowId).toBe("u3");
  });

  it("returns to the top of the message the reader is inside before stepping back", () => {
    expect(railTarget(items, 5, "previous")?.rowId).toBe("u2");
    expect(railTarget(items, 5, "next")?.rowId).toBe("u3");
  });

  it("goes to the first message from the leading rows", () => {
    expect(railTarget(items, 0, "next")?.rowId).toBe("u1");
    expect(railTarget(items, 0, "previous")).toBeUndefined();
  });

  it("does nothing past the last message", () => {
    expect(railTarget(items, 8, "next")).toBeUndefined();
  });

  it("steps from the last message on screen at the end of the list", () => {
    expect(railTarget(items, 5, "next", 8)).toBeUndefined();
    expect(railTarget(items, 5, "previous", 8)?.rowId).toBe("u2");
  });
});
