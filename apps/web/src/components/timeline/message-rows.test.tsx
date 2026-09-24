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

describe("UserMessageRow", () => {
  it("renders a row without references as text alone", () => {
    const markup = renderToStaticMarkup(<UserMessageRow item={row({})} />);
    // The bubble holds the text and nothing else, as it did before references.
    expect(markup).toMatch(
      /aria-label="User message"[^>]*>Add a health check endpoint\.<\/div><\/div>$/,
    );
    expect(markup).not.toContain("<svg");
    // An empty list is the same as none: no chip row is drawn for it.
    expect(renderToStaticMarkup(<UserMessageRow item={row({ references: [] })} />)).toBe(markup);
  });

  it("draws one chip per skill and plugin above the text", () => {
    const markup = renderToStaticMarkup(
      <UserMessageRow
        item={row({
          references: [
            { kind: "skill", name: "health-checks" },
            { kind: "plugin", name: "formatter" },
          ],
        })}
      />,
    );
    expect(markup).toContain('aria-label="References"');
    expect(markup.match(/role="listitem"/g)).toHaveLength(2);
    expect(markup).toContain('title="Skill health-checks"');
    expect(markup).toContain('title="Plugin formatter"');
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup.indexOf("formatter")).toBeLessThan(markup.indexOf("Add a health check"));
  });
});
