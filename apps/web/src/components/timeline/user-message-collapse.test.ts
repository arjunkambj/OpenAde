import { describe, expect, it } from "vitest";

import {
  USER_MESSAGE_MAX_CHARS,
  USER_MESSAGE_MAX_LINES,
  userMessageOverflows,
} from "@/components/timeline/user-message-collapse";

const lines = (count: number, separator = "\n") =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(separator);

describe("userMessageOverflows", () => {
  it("leaves a short message open", () => {
    expect(userMessageOverflows("")).toBe(false);
    expect(userMessageOverflows("Add a health check endpoint.")).toBe(false);
  });

  it("keeps exactly the line limit open and collapses one line more", () => {
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES))).toBe(false);
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES + 1))).toBe(true);
  });

  it("keeps exactly the character limit open and collapses one character more", () => {
    expect(userMessageOverflows("a".repeat(USER_MESSAGE_MAX_CHARS))).toBe(false);
    expect(userMessageOverflows("a".repeat(USER_MESSAGE_MAX_CHARS + 1))).toBe(true);
  });

  it("does not count a trailing newline, which renders no line", () => {
    expect(userMessageOverflows(`${lines(USER_MESSAGE_MAX_LINES)}\n`)).toBe(false);
    expect(userMessageOverflows(`\n\n${lines(USER_MESSAGE_MAX_LINES)}\n\n  \n`)).toBe(false);
  });

  it("counts only lines with text, so paragraphs that fit are not clamped", () => {
    // Six one-line paragraphs: eleven lines as typed, six lines and five gaps on screen.
    const paragraphs = lines(6, "\n\n");
    expect(paragraphs.split("\n")).toHaveLength(11);
    expect(userMessageOverflows(paragraphs)).toBe(false);
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES, "\n\n\n"))).toBe(false);
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES + 1, "\n\n"))).toBe(true);
  });

  it("counts a CRLF as one line break and one character", () => {
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES, "\r\n"))).toBe(false);
    expect(userMessageOverflows(lines(USER_MESSAGE_MAX_LINES + 1, "\r\n"))).toBe(true);
    // 605 characters as written, 600 once each CRLF counts as one.
    const crlf = `${"a\r\n".repeat(5)}${"a".repeat(USER_MESSAGE_MAX_CHARS - 10)}`;
    expect(crlf.length).toBeGreaterThan(USER_MESSAGE_MAX_CHARS);
    expect(userMessageOverflows(crlf)).toBe(false);
  });
});
