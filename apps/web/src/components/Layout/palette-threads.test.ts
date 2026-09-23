import { describe, expect, it } from "vitest";

import { paletteThreads } from "./palette-threads";

const thread = (threadId: string, status: "idle" | "waiting" | "archived") => ({
  threadId,
  status,
});

describe("paletteThreads", () => {
  it("lists live threads before archived ones", () => {
    const threads = [thread("a", "archived"), thread("b", "idle"), thread("c", "waiting")];
    expect(paletteThreads(threads).map((t) => t.threadId)).toEqual(["b", "c", "a"]);
  });

  it("keeps the order within each part", () => {
    const threads = [
      thread("x", "archived"),
      thread("b", "idle"),
      thread("y", "archived"),
      thread("a", "idle"),
    ];
    expect(paletteThreads(threads).map((t) => t.threadId)).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps every thread", () => {
    expect(paletteThreads([])).toEqual([]);
    expect(paletteThreads([thread("x", "archived")])).toHaveLength(1);
  });
});
