import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RailItem } from "@/components/timeline/turn-rail";
import { TurnRail } from "@/components/timeline/turn-rail-view";

const item = (index: number): RailItem => ({
  rowId: `u${index}`,
  rowIndex: index * 3,
  preview: `First line of message ${index}`,
});

const render = (count: number) =>
  renderToStaticMarkup(
    <TurnRail
      listRef={{ current: null }}
      navigation={{
        items: Array.from({ length: count }, (_, i) => item(i)),
        goTo: () => {},
      }}
    />,
  );

describe("TurnRail", () => {
  it("renders nothing with fewer than two messages", () => {
    expect(render(0)).toBe("");
    expect(render(1)).toBe("");
  });

  it("draws one labelled tick per message", () => {
    const markup = render(3);
    const labels = [...markup.matchAll(/aria-label="(Go to message \d+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Go to message 1", "Go to message 2", "Go to message 3"]);
    expect(markup).toContain('aria-label="Messages in this thread"');
  });

  it("hides itself below the width it needs, by its own container", () => {
    const markup = render(2);
    expect(markup).toContain("@container/rail");
    expect(markup).toMatch(/<nav[^>]*class="[^"]*\bhidden\b[^"]*@min-\[800px\]\/rail:flex/);
  });

  it("marks no tick current before the list reports where it is", () => {
    expect(render(3)).not.toContain("aria-current");
  });
});
