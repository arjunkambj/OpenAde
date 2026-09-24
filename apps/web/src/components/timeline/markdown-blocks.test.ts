import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "./markdown-blocks";

const sources = (text: string) => splitMarkdownBlocks(text).blocks.map((block) => block.source);

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines and leaves them out of every block", () => {
    const text = "# Title\nIntro line.\n\n\nSecond paragraph.\n\n";
    const { blocks } = splitMarkdownBlocks(text);
    expect(blocks.map((block) => block.source)).toEqual([
      "# Title\nIntro line.",
      "Second paragraph.",
    ]);
    expect(blocks.map((block) => block.key)).toEqual(["b0", "b1"]);
    for (const block of blocks) {
      expect(text.slice(block.start, block.start + block.source.length)).toBe(block.source);
      expect(block.open).toBe(false);
    }
  });

  it("gives empty or blank text no blocks", () => {
    expect(sources("")).toEqual([]);
    expect(sources("\n  \n\t\n")).toEqual([]);
  });

  it("keeps a fence with blank lines inside it in one block", () => {
    const fence = "```ts\nconst a = 1;\n\n\nconst b = 2;\n```";
    expect(sources(`Before.\n\n${fence}\n\nAfter.`)).toEqual(["Before.", fence, "After."]);
  });

  it("closes a fence only on a run of the same character at least as long", () => {
    const fence = "````md\n```\n\n~~~\n\n````";
    expect(sources(`${fence}\n\nAfter.`)).toEqual([fence, "After."]);
    // A backtick run with text after it is content, not a close.
    const withInfo = "```\n``` not a close\n\nstill code\n```";
    expect(sources(withInfo)).toEqual([withInfo]);
  });

  it("handles tilde fences", () => {
    const fence = "~~~bash\nnpm test\n\nnpm run build\n~~~";
    expect(sources(`${fence}\n\nDone.`)).toEqual([fence, "Done."]);
  });

  it("flags an unterminated final fence as open, blank lines and all", () => {
    const { blocks } = splitMarkdownBlocks("Intro.\n\n```ts\nconst a = 1;\n\nconst b");
    expect(blocks.map((block) => [block.source, block.open])).toEqual([
      ["Intro.", false],
      ["```ts\nconst a = 1;\n\nconst b", true],
    ]);
  });

  it("does not open a fence on a backtick run whose info holds a backtick", () => {
    expect(sources("``` a`b\n\nNext.")).toEqual(["``` a`b", "Next."]);
  });

  it("keeps a loose list, its nested lists and its indented paragraphs together", () => {
    const list = [
      "1. First",
      "",
      "   More about the first.",
      "",
      "   - nested",
      "",
      "     - deeper",
      "",
      "2. Second",
      "",
      "- a bullet after the numbers",
    ].join("\n");
    expect(sources(`${list}\n\nAfter the list.`)).toEqual([list, "After the list."]);
  });

  it("keeps a fence inside a list item in the item's block", () => {
    const list = "- step\n\n  ```sh\n  npm test\n\n  npm run lint\n  ```\n\n- next step";
    expect(sources(list)).toEqual([list]);
  });

  it("keeps a blockquote's paragraphs together and ends it at other text", () => {
    const quote = "> one\n\n> two";
    expect(sources(`${quote}\n\nPlain.`)).toEqual([quote, "Plain."]);
  });

  it("runs an HTML comment until it closes", () => {
    const comment = "<!-- hidden\n\nstill hidden -->";
    expect(sources(`${comment}\n\nShown.`)).toEqual([comment, "Shown."]);
    expect(sources("<!-- one line -->\n\nShown.")).toEqual(["<!-- one line -->", "Shown."]);
  });

  it("keeps each block's key and source as the text grows", () => {
    const full =
      "First paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n\n- two\n\nEnd.";
    let settled: Array<{ key: string; source: string }> = [];
    for (let length = 1; length <= full.length; length += 1) {
      const { blocks } = splitMarkdownBlocks(full.slice(0, length));
      // Every block but the last is final: the same key, the same source.
      blocks.slice(0, -1).forEach((block, index) => {
        const before = settled[index];
        if (before !== undefined) {
          expect(block).toMatchObject(before);
        }
      });
      settled = blocks.slice(0, -1).map(({ key, source }) => ({ key, source }));
    }
    expect(sources(full)).toEqual([
      "First paragraph.",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "- one\n\n- two",
      "End.",
    ]);
  });

  it("collects link reference definitions outside fences", () => {
    const text = [
      "See [the docs][1] and [spec].",
      "",
      "[1]: https://example.com/docs",
      "[spec]: <https://example.com/spec> 'Spec'",
      "[^note]: a footnote is not a link definition",
      "",
      "```md",
      "[2]: https://example.com/in-a-fence",
      "```",
    ].join("\n");
    expect(splitMarkdownBlocks(text).definitions).toBe(
      "[1]: https://example.com/docs\n[spec]: <https://example.com/spec> 'Spec'",
    );
    expect(splitMarkdownBlocks("No definitions.").definitions).toBe("");
  });

  it("keeps CRLF line endings inside the sources", () => {
    expect(sources("one\r\ntwo\r\n\r\nthree")).toEqual(["one\r\ntwo", "three"]);
  });
});
