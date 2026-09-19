/**
 * The line splitter's contract: complete lines out in order, a bounded partial
 * tail, and the unterminated final frame delivered by `flush` at EOF.
 */

import { describe, expect, it } from "@effect/vitest";

import { makeLineSplitter, MAX_LINE_CHARS, parseFrame } from "./ndjson";

describe("makeLineSplitter", () => {
  it("splits chunks into complete lines and holds the partial tail", () => {
    const splitter = makeLineSplitter();
    expect(splitter.push('{"a":1}\n{"b')).toEqual({ lines: ['{"a":1}'], overflow: null });
    expect(splitter.push('":2}\n')).toEqual({ lines: ['{"b":2}'], overflow: null });
  });

  it("flush returns the unterminated tail once, then nothing", () => {
    const splitter = makeLineSplitter();
    expect(splitter.push("done\npartial-tail").lines).toEqual(["done"]);
    expect(splitter.flush()).toBe("partial-tail");
    expect(splitter.flush()).toBeNull();
  });

  it("drops an over-cap unterminated line and reports the overflow", () => {
    const splitter = makeLineSplitter();
    const giant = `{"type":"event","event":{"type":"run_end"${"x".repeat(MAX_LINE_CHARS)}`;
    const pushed = splitter.push(`${giant}still-going`);
    expect(pushed.lines).toEqual([]);
    expect(pushed.overflow?.droppedChars).toBeGreaterThan(MAX_LINE_CHARS);
    // The head names the frame, so the warning can say what was lost.
    expect(pushed.overflow?.head).toContain("run_end");
    // The buffer is reset: the next line still parses normally.
    expect(splitter.push("\nnext\n").lines).toEqual(["next"]);
  });

  it("does not surface the rest of a line it gave up on", () => {
    // The remainder used to reach the parser as a truncated fragment and
    // surface as an `event.unmapped` that ingestion drops — noise about a
    // frame that was already reported lost.
    const splitter = makeLineSplitter();
    splitter.push("y".repeat(MAX_LINE_CHARS + 10));
    expect(splitter.push("more-of-the-same-line")).toEqual({ lines: [], overflow: null });
    expect(splitter.push('and-more\n{"a":1}\n').lines).toEqual(['{"a":1}']);
  });

  /**
   * `run_end` carries `nextState.messages` — the whole conversation, content
   * blocks and all — and `fixtures/cmd/image/` shows those include the
   * harness's base64 image block. Every later turn replays that history, so
   * once a screenshot is in a thread each `run_end` grows by the transcoded
   * bytes. At the old one-megabyte cap that line was dropped, and with it the
   * `nextState` reconcile and the turn's final usage — for that turn and every
   * turn after it.
   */
  it("holds a run_end big enough to carry a screenshot", () => {
    const splitter = makeLineSplitter();
    const half = 2 * 1024 * 1024;
    expect(splitter.push("z".repeat(half)).overflow).toBeNull();
    expect(splitter.push("z".repeat(half)).overflow).toBeNull();
    expect(splitter.push("\n").lines[0]?.length).toBe(2 * half);
  });

  it("a giant newline-terminated line is emitted, not capped", () => {
    // The cap guards the *unterminated* tail — a completed line has already
    // left the buffer, so it flows through for the parser to judge.
    const splitter = makeLineSplitter();
    const giant = "x".repeat(MAX_LINE_CHARS + 10);
    const pushed = splitter.push(`${giant}\n`);
    expect(pushed.lines).toEqual([giant]);
    expect(pushed.overflow).toBeNull();
  });
});

describe("parseFrame", () => {
  it("rejects non-JSON and unknown envelopes", () => {
    expect(parseFrame("not json")).toMatchObject({ message: "not JSON" });
    expect(parseFrame('"a string"')).toMatchObject({ message: "not an object" });
    expect(parseFrame('{"type":"mystery"}')).toMatchObject({
      message: "unknown frame type mystery",
    });
  });
});
