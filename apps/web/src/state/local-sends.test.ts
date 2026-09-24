import { describe, expect, it } from "vitest";

import { LOCAL_SEND_WINDOW_MS, noteLocalSend, sentHereRecently } from "@/state/local-sends";

describe("local sends", () => {
  it("knows nothing of a thread this window never sent to", () => {
    expect(sentHereRecently("thread-never", 1_000)).toBe(false);
  });

  it("counts a send made here within the window, per thread", () => {
    noteLocalSend("thread-a", 1_000);
    expect(sentHereRecently("thread-a", 1_000)).toBe(true);
    expect(sentHereRecently("thread-a", 1_000 + LOCAL_SEND_WINDOW_MS)).toBe(true);
    expect(sentHereRecently("thread-b", 1_000)).toBe(false);
  });

  it("forgets it once the window has passed, as with a queued message drained later", () => {
    noteLocalSend("thread-c", 1_000);
    expect(sentHereRecently("thread-c", 1_001 + LOCAL_SEND_WINDOW_MS)).toBe(false);
  });

  it("takes the latest send", () => {
    noteLocalSend("thread-d", 1_000);
    noteLocalSend("thread-d", 60_000);
    expect(sentHereRecently("thread-d", 60_000 + 5_000)).toBe(true);
  });
});
