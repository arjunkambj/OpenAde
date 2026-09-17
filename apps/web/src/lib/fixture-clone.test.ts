import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import * as Schema from "effect/Schema";
import { uuidV7Millis } from "@OpenAde/shared/ids";
import { describe, expect, it } from "vitest";

import { cloneItems } from "./fixture-clone";

const snapshot = Schema.decodeUnknownSync(ThreadDetailSnapshot)(fixture);

describe("cloneItems", () => {
  it("leaves a single copy untouched", () => {
    expect(cloneItems(snapshot.items, 1)).toBe(snapshot.items);
  });

  it("mints a distinct id for every clone of every item", () => {
    const items = cloneItems(snapshot.items, 50);
    expect(items).toHaveLength(snapshot.items.length * 50);
    expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
  });

  it("keeps every clone decodable as an item id", () => {
    const items = cloneItems(snapshot.items, 10);
    for (const item of items) {
      expect(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)({ ...fixture, items: [item] }),
      ).not.toThrow();
    }
  });

  it("points a child at the parent inside its own copy", () => {
    const nested = snapshot.items.find((item) => item.parentItemId !== undefined);
    expect(nested).toBeDefined();
    const items = cloneItems(snapshot.items, 3);
    for (const item of items) {
      if (item.parentItemId !== undefined) {
        expect(items.some((candidate) => candidate.itemId === item.parentItemId)).toBe(true);
      }
    }
  });

  it("spreads the timestamps so a fold reports a real duration", () => {
    const items = cloneItems(snapshot.items, 2);
    const millis = items.map((item) => uuidV7Millis(item.itemId));
    expect(millis.every((value) => value !== undefined)).toBe(true);
    expect(new Set(millis).size).toBe(items.length);
  });
});
