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
});
