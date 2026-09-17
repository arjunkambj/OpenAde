import { describe, expect, it } from "vitest";

import { isUnread, markSeen, parseSeen, SEEN_LIMIT, type SeenMap } from "./thread-seen";

const at = (minute: number): string => `2026-09-18T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("parseSeen", () => {
  it("survives every shape localStorage can hand back", () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen(undefined)).toEqual({});
    expect(parseSeen("not json")).toEqual({});
    expect(parseSeen("[1,2]")).toEqual({});
    expect(parseSeen('{"a":1,"b":"x"}')).toEqual({ b: "x" });
  });
});

describe("isUnread", () => {
  const seen: SeenMap = { t1: at(10) };

  it("is false for a thread the user has never opened", () => {
    // The dot means "changed since you last looked", so a restored history of
    // old threads must not light every row up on first launch.
    expect(isUnread(seen, { threadId: "t9", updatedAt: at(59) })).toBe(false);
  });

  it("is false while the thread has not moved past the stamp", () => {
    expect(isUnread(seen, { threadId: "t1", updatedAt: at(10) })).toBe(false);
    expect(isUnread(seen, { threadId: "t1", updatedAt: at(9) })).toBe(false);
  });

  it("is true once the thread has changed since it was last open", () => {
    expect(isUnread(seen, { threadId: "t1", updatedAt: at(11) })).toBe(true);
  });
});

describe("markSeen", () => {
  it("returns the very same map when nothing changed", () => {
    const seen: SeenMap = { t1: at(10) };
    // Reference equality: the sidebar writes this from an effect, and a fresh
    // object every render would loop.
    expect(markSeen(seen, "t1", at(10))).toBe(seen);
  });

  it("records a new stamp and clears the unread state", () => {
    const next = markSeen({ t1: at(10) }, "t1", at(12));
    expect(next).toEqual({ t1: at(12) });
    expect(isUnread(next, { threadId: "t1", updatedAt: at(12) })).toBe(false);
  });

  it("keeps the newest stamps when the map outgrows its cap", () => {
    let seen: SeenMap = {};
    for (let i = 0; i < SEEN_LIMIT + 5; i += 1) {
      // Distinct, increasing stamps: thread i is newer than thread i - 1.
      seen = markSeen(seen, `t${i}`, `2026-09-18T${String(i % 24).padStart(2, "0")}:00:00.000Z`);
    }
    expect(Object.keys(seen).length).toBe(SEEN_LIMIT);
    // The thread just marked always survives the prune.
    expect(seen[`t${SEEN_LIMIT + 4}`]).toBeDefined();
  });
});
