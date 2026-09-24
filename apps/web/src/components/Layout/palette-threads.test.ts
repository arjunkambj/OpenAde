import { describe, expect, it } from "vitest";

import { paletteThreads, threadJumpCommand } from "./palette-threads";

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

describe("threadJumpCommand", () => {
  const order = Array.from({ length: 11 }, (_, index) => ({ threadId: `t${index + 1}` }));

  it("numbers a thread by its sidebar row", () => {
    expect(threadJumpCommand(order, "t1")).toBe("thread.jump.1");
    expect(threadJumpCommand(order, "t9")).toBe("thread.jump.9");
  });

  it("has nothing past the ninth row or off the sidebar", () => {
    expect(threadJumpCommand(order, "t10")).toBeUndefined();
    expect(threadJumpCommand(order, "archived")).toBeUndefined();
  });
});
