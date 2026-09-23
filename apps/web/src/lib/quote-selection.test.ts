import { describe, expect, it } from "vitest";

import { appendQuotedBlock } from "./quote-selection";

describe("appendQuotedBlock", () => {
  it("quotes every line of a selection into an empty draft", () => {
    expect(appendQuotedBlock("", "$ pnpm test\nFAIL src/a.test.ts")).toBe(
      "> $ pnpm test\n> FAIL src/a.test.ts\n\n",
    );
  });

  it("drops the spaces xterm pads onto each selected line", () => {
    expect(appendQuotedBlock("", "error: boom      \n  at main.ts:3   \t")).toBe(
      "> error: boom\n>   at main.ts:3\n\n",
    );
  });

  it("drops blank lines before and after the text but keeps those inside it", () => {
    expect(appendQuotedBlock("", "\n   \nfirst\n\n  \nsecond\n    \n\n")).toBe(
      "> first\n>\n>\n> second\n\n",
    );
  });

  it("reads carriage-return line ends as line breaks", () => {
    expect(appendQuotedBlock("", "one\r\ntwo\rthree")).toBe("> one\n> two\n> three\n\n");
  });

  it("separates the block from existing draft text with one blank line", () => {
    expect(appendQuotedBlock("Why does this fail?", "exit 1")).toBe(
      "Why does this fail?\n\n> exit 1\n\n",
    );
    // Whatever the draft already ended with, the gap is one blank line.
    expect(appendQuotedBlock("Why?\n\n\n  ", "exit 1")).toBe("Why?\n\n> exit 1\n\n");
  });

  it("stacks a second quote under the first as its own block", () => {
    const once = appendQuotedBlock("", "first");
    expect(appendQuotedBlock(once, "second")).toBe("> first\n\n> second\n\n");
  });

  it("leaves the draft unchanged for an empty or blank selection", () => {
    expect(appendQuotedBlock("keep me ", "")).toBe("keep me ");
    expect(appendQuotedBlock("keep me ", "   \n\t\n  ")).toBe("keep me ");
  });
});
