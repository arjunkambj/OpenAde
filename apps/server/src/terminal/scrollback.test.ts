import { TERMINAL_SCROLLBACK_CHARS } from "@OpenAde/contracts/terminal";
import { describe, expect, it } from "vitest";

import { makeScrollback } from "./scrollback";

describe("makeScrollback", () => {
  it("keeps everything while under the bound", () => {
    const scrollback = makeScrollback(100);
    scrollback.append("one\n");
    scrollback.append("two");
    scrollback.append("");
    expect(scrollback.snapshot()).toEqual({ data: "one\ntwo", offset: 7 });
  });

  it("starts empty at offset zero", () => {
    expect(makeScrollback().snapshot()).toEqual({ data: "", offset: 0 });
  });

  it("drops the oldest output past the bound and starts the replay at a line start", () => {
    const scrollback = makeScrollback(10);
    scrollback.append("aaaa\n");
    scrollback.append("bbbb\n");
    // 17 chars: the 7 over the bound go, leaving "bb\ncc\x1b[31m", which
    // starts mid-line, so the cut drops through the first newline.
    scrollback.append("cc\x1b[31m");
    const { data, offset } = scrollback.snapshot();
    expect(offset).toBe(17);
    expect(data.length).toBeLessThanOrEqual(10);
    expect(data).toBe("cc\x1b[31m");
  });

  it("never starts a replay in the middle of a line or an escape sequence", () => {
    const scrollback = makeScrollback(12);
    scrollback.append("\x1b[1mbold\x1b[0m line one\n");
    scrollback.append("line two\n");
    const { data } = scrollback.snapshot();
    expect(data).toBe("line two\n");
  });

  it("cuts inside one oversized append", () => {
    const scrollback = makeScrollback(8);
    scrollback.append("0123456789\nabc\ndef");
    expect(scrollback.snapshot()).toEqual({ data: "abc\ndef", offset: 18 });
  });

  it("keeps output with no newline at all rather than replay nothing", () => {
    const scrollback = makeScrollback(4);
    scrollback.append("progress 10%\rprogress 20%");
    expect(scrollback.snapshot()).toEqual({ data: " 20%", offset: 25 });
  });

  it("stays within the bound however the output arrives", () => {
    const scrollback = makeScrollback(1000);
    let produced = 0;
    for (let i = 0; i < 5000; i++) {
      const line = i % 7 === 0 ? `${"x".repeat(i % 300)}\n` : `k${i}`;
      scrollback.append(line);
      produced += line.length;
      const { data, offset } = scrollback.snapshot();
      expect(data.length).toBeLessThanOrEqual(1000);
      expect(offset).toBe(produced);
    }
  });

  it("counts every char produced, so the offset only grows", () => {
    const scrollback = makeScrollback(16);
    let last = scrollback.offset();
    for (const chunk of ["abc\n", "", "defghijklmnop\n", "q".repeat(40), "\n", "r"]) {
      scrollback.append(chunk);
      expect(scrollback.offset()).toBeGreaterThanOrEqual(last);
      last = scrollback.offset();
    }
    expect(last).toBe(4 + 14 + 40 + 1 + 1);
    expect(scrollback.snapshot().offset).toBe(last);
  });

  it("defaults to the shared scrollback limit", () => {
    const scrollback = makeScrollback();
    const line = `${"y".repeat(1023)}\n`;
    for (let i = 0; i < TERMINAL_SCROLLBACK_CHARS / 1024 + 10; i++) scrollback.append(line);
    const { data } = scrollback.snapshot();
    expect(data.length).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_CHARS);
    expect(data.length).toBeGreaterThan(TERMINAL_SCROLLBACK_CHARS - 1024);
    expect(data.startsWith("y")).toBe(true);
  });
});
