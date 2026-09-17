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
    const giant = "x".repeat(MAX_LINE_CHARS + 10);
    const pushed = splitter.push(`${giant}still-going`);
    expect(pushed.lines).toEqual([]);
    expect(pushed.overflow).not.toBeNull();
    expect(pushed.overflow?.droppedChars).toBeGreaterThan(MAX_LINE_CHARS);
    // The buffer is reset: the next line still parses normally.
    expect(splitter.push("\nnext\n").lines).toEqual(["next"]);
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
