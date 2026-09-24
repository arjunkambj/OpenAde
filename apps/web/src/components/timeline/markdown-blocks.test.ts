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
    expect(blocks.map((block) => [block.source, block.open, block.openFrom])).toEqual([
      ["Intro.", false, undefined],
      ["```ts\nconst a = 1;\n\nconst b", true, 0],
    ]);
  });

  /** The open fence's line, as the last block reports it. */
  const openLine = (text: string) => {
    const last = splitMarkdownBlocks(text).blocks.at(-1)!;
    return last.openFrom === undefined
      ? undefined
      : last.source.slice(last.openFrom).split("\n")[0];
  };

  it("points at the open fence where it starts in the block", () => {
    expect(openLine("Intro\n```ts\nconst a")).toBe("```ts");
    expect(openLine("```ts\na\n```\nafter")).toBeUndefined();
    expect(openLine("````\n```\na")).toBe("````");
    expect(openLine("```\n``` ts\na")).toBe("```");
  });

  it("finds a fence nested four or more spaces deep in a list", () => {
    expect(openLine("Steps:\n\n- a\n  - b\n    ```ts\n    const x = 1;\n    let")).toBe(
      "    ```ts",
    );
    expect(openLine("1. one\n\n    ```ts\n    const y")).toBe("    ```ts");
  });

  it("finds a fence inside a blockquote and ends it with the quote", () => {
    expect(openLine("> ```ts\n> const z")).toBe("> ```ts");
    expect(openLine("> > ```ts\n> > a\n> >\n> > b")).toBe("> > ```ts");
    // one level out is past the inner quote, and past its fence
    expect(openLine("> > ```ts\n> > a\n> b")).toBeUndefined();
    // closed inside the quote
    expect(openLine("> ```ts\n> a\n> ```\n> after")).toBeUndefined();
    // the quote ended, and the fence with it: a blank line splits after it
    const ended = "> ```ts\n> a\n\nOutside.";
    expect(sources(ended)).toEqual(["> ```ts\n> a", "Outside."]);
    expect(splitMarkdownBlocks(ended).blocks.every((block) => !block.open)).toBe(true);
  });

  it("reads a quoted or deeply indented backtick run inside a fence as code", () => {
    // Markdown about markdown: a `> ```` line in a fence opened outside a quote.
    const quoted = "```\ncode\n> ```\nmore\n```";
    expect(sources(`${quoted}\n\nAfter.`)).toEqual([quoted, "After."]);
    expect(splitMarkdownBlocks(`${quoted}\n\nAfter.`).blocks.every((block) => !block.open)).toBe(
      true,
    );
    // Inside a quote, a deeper quote's fence is code too.
    expect(openLine("> ```\n> > ```\n> a")).toBe("> ```");
    // Four columns past the opener is code; up to three closes.
    const indented = "```\n    ```\nstill code\n```";
    expect(sources(`${indented}\n\nAfter.`)).toEqual([indented, "After."]);
    expect(openLine("```\na\n   ```\nafter")).toBeUndefined();
    // A fence in a list item closes at the item's indent and a little past it.
    expect(openLine("- a\n\n    ```ts\n    x\n      ```\n    y")).toBeUndefined();
  });

  it("collects the definitions after a quoted backtick run in a fence", () => {
    const text = "```\n> ```\n```\n\nSee [docs][1].\n\n[1]: https://example.com";
    expect(splitMarkdownBlocks(text).definitions).toBe("[1]: https://example.com");
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

  it("opens a comment only at the start of a line, so a fence after an inline one holds", () => {
    const fence = "```html\n<!-- x -->\n\n<p>hi</p>\n```";
    const text = `Use \`<!--\` to open a comment.\n\n${fence}\n\nDone.`;
    expect(sources(text)).toEqual(["Use `<!--` to open a comment.", fence, "Done."]);
    expect(sources("Say <!-- here\n\nand after.")).toEqual(["Say <!-- here", "and after."]);
    expect(sources("   <!-- indented\n\nhidden -->\n\nShown.")).toEqual([
      "   <!-- indented\n\nhidden -->",
      "Shown.",
    ]);
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
