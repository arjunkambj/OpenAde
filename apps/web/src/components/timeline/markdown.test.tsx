import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/timeline/markdown";

const INLINE_CHIP = "bg-hover px-1";

const render = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} />);

describe("MarkdownBody", () => {
  it("renders a fence without a language as a block, not as inline code", () => {
    const markup = render(["```", "npm test", "```"].join("\n"));
    expect(markup).toContain("<pre");
    expect(markup).toContain("npm test");
    expect(markup).not.toContain(INLINE_CHIP);
  });

  it("keeps inline code inline", () => {
    const markup = render("Run `npm test` first.");
    expect(markup).not.toContain("<pre");
    expect(markup).toContain(INLINE_CHIP);
    expect(markup).toContain(">npm test</code>");
  });

  it("drops the newline the parser appends to a block's text", () => {
    const markup = render(["```ts", "const a = 1;", "```"].join("\n"));
    expect(markup).toContain("const a = 1;</code>");
    expect(markup).not.toContain(INLINE_CHIP);
  });
});
