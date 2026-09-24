import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/timeline/markdown";

const INLINE_CHIP = "bg-hover px-1";

// No worker pool is mounted here, so every block renders its plain fallback.
const render = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} />);

describe("MarkdownBody", () => {
  it("renders a fence without a language as a code block, not as inline code", () => {
    const markup = render(["```", "npm test", "```"].join("\n"));
    expect(markup).toContain('role="group" aria-label="Code: Text"');
    expect(markup).toContain("<pre");
    expect(markup).toContain("npm test");
    expect(markup).not.toContain(INLINE_CHIP);
  });

  it("keeps inline code inline", () => {
    const markup = render("Run `npm test` first.");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain('role="group"');
    expect(markup).toContain(INLINE_CHIP);
    expect(markup).toContain(">npm test</code>");
  });

  it("drops the newline the parser appends to a block's text", () => {
    const markup = render(["```ts", "const a = 1;", "```"].join("\n"));
    expect(markup).toContain("const a = 1;</code>");
    expect(markup).not.toContain(INLINE_CHIP);
  });

  it("labels a block with its language and gives it copy and wrap buttons", () => {
    const markup = render(["```ts", "const a = 1;", "```"].join("\n"));
    expect(markup).toContain(">TypeScript</span>");
    expect(markup).toContain('aria-label="Copy TypeScript"');
    expect(markup).toContain('aria-label="Wrap lines"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("labels a block with the file its fence names", () => {
    const markup = render(['```ts title="src/app.ts"', "export {};", "```"].join("\n"));
    expect(markup).toContain('aria-label="Code: src/app.ts"');
    expect(markup).toContain(">src/app.ts</span>");
    expect(markup).not.toContain("TypeScript");
  });

  it("still renders an unterminated fence as a block while streaming", () => {
    const markup = renderToStaticMarkup(
      <MarkdownBody text={["Intro", "```ts", "const a"].join("\n")} id="item" streaming />,
    );
    expect(markup).toContain('aria-label="Code: TypeScript"');
    expect(markup).toContain("const a</code>");
  });

  it("renders block by block into the same flat body", () => {
    const markup = render(["# Title", "", "First.", "", "- a", "", "- b", "", "Last."].join("\n"));
    // One list for the loose items, and every element a child of the body.
    expect(markup.match(/<ul/g)).toHaveLength(1);
    expect(markup).toMatch(/^<div class="[^"]*"><h1 [^>]*>Title<\/h1><p [^>]*>First\.<\/p><ul /);
    expect(markup).toMatch(/<p [^>]*>Last\.<\/p><\/div>$/);
  });

  it("resolves a reference link whose definition is in another block", () => {
    const markup = render("See [the docs][1].\n\n[1]: https://example.com/docs");
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).not.toContain("[1]");
  });

  describe("user variant", () => {
    const user = (text: string) =>
      renderToStaticMarkup(<MarkdownBody text={text} id="item" variant="user" />);

    it("gives inline code a chip that reads on the bubble", () => {
      const markup = user("Run `npm test` first.");
      expect(markup).toContain("bg-background/60");
      expect(markup).not.toContain(INLINE_CHIP);
    });

    it("keeps a code block's line endings and renders it as a block", () => {
      const markup = user(["```sh", "npm install", "npm test", "```"].join("\n"));
      expect(markup).toContain('aria-label="Code: Shell"');
      expect(markup).toContain("npm install\nnpm test</code>");
      expect(markup).not.toContain("<br/>");
    });

    it("breaks the lines of an HTML block it shows as text", () => {
      const markup = user(["<div>", "a block", "</div>"].join("\n"));
      expect(markup).toMatch(/<p [^>]*>&lt;div&gt;<br\/>\s*a block<br\/>\s*&lt;\/div&gt;<\/p>/);
    });

    it("leaves the agent variant's single line endings as soft breaks", () => {
      expect(render("first\nsecond")).not.toContain("<br/>");
    });
  });
});
