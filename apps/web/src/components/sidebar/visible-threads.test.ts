import { describe, expect, it } from "vitest";

import { sidebarThreads } from "./visible-threads";

const thread = (threadId: string, status: "idle" | "running" | "archived") => ({
  threadId,
  status,
});

describe("sidebarThreads", () => {
  it("leaves archived threads out", () => {
    const threads = [thread("a", "idle"), thread("b", "archived"), thread("c", "running")];
    expect(sidebarThreads(threads, null).map((t) => t.threadId)).toEqual(["a", "c"]);
  });

  it("keeps the archived thread that is open", () => {
    const threads = [thread("a", "archived"), thread("b", "archived")];
    expect(sidebarThreads(threads, "b").map((t) => t.threadId)).toEqual(["b"]);
  });

  it("keeps the order it was given", () => {
    const threads = [thread("c", "idle"), thread("x", "archived"), thread("a", "idle")];
    expect(sidebarThreads(threads, "x").map((t) => t.threadId)).toEqual(["c", "x", "a"]);
  });
});
