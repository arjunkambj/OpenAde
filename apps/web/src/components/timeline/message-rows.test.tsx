import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { makeItemId } from "@OpenAde/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserMessageRow } from "@/components/timeline/message-rows";

const row = (fields: Partial<ItemSnapshot>): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "user_message",
  status: "completed",
  text: "Add a health check endpoint.",
  ...fields,
});

const render = (fields: Partial<ItemSnapshot>) =>
  renderToStaticMarkup(<UserMessageRow item={row(fields)} />);

describe("UserMessageRow", () => {
  it("renders a row without references as its text alone", () => {
    const itemId = makeItemId();
    const markup = render({ itemId });
    // The bubble holds one markdown body with one paragraph, and nothing else.
    expect(markup).toMatch(
      /aria-label="User message"[^>]*><div class="[^"]*"><p [^>]*>Add a health check endpoint\.<\/p><\/div><\/div><\/div>$/,
    );
    expect(markup).not.toContain("<svg");
    // An empty list is the same as none: no chip row is drawn for it.
    expect(render({ itemId, references: [] })).toBe(markup);
  });

  it("draws one chip per skill and plugin above the text", () => {
    const markup = render({
      references: [
        { kind: "skill", name: "health-checks" },
        { kind: "plugin", name: "formatter" },
      ],
    });
    expect(markup).toContain('aria-label="References"');
    expect(markup.match(/role="listitem"/g)).toHaveLength(2);
    expect(markup).toContain('title="Skill health-checks"');
    expect(markup).toContain('title="Plugin formatter"');
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup.indexOf("formatter")).toBeLessThan(markup.indexOf("Add a health check"));
  });

  it("renders the text as markdown", () => {
    const markup = render({ text: "Please:\n\n- run `npm test`\n- fix **what fails**" });
    expect(markup).toContain("<ul");
    expect(markup.match(/<li/g)).toHaveLength(2);
    expect(markup).toContain(">npm test</code>");
    expect(markup).toContain("<strong>what fails</strong>");
  });

  it("keeps a single line ending as a line break", () => {
    const markup = render({ text: "first line\nsecond line" });
    expect(markup).toMatch(/first line<br\/>\s*second line/);
  });

  it("shows raw HTML as the text it is", () => {
    const markup = render({ text: "Make it <b>bold</b>\n\n<div>a block</div>" });
    expect(markup).toContain("Make it &lt;b&gt;bold&lt;/b&gt;");
    expect(markup).toContain("&lt;div&gt;a block&lt;/div&gt;");
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<div>a block");
  });

  it("keeps a heading at the size of the text", () => {
    const markup = render({ text: "# Plan\n\nDo it." });
    expect(markup).toMatch(/<h1 class="[^"]*text-sm font-semibold[^"]*">Plan<\/h1>/);
  });
});
