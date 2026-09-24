import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TriggerMenu, type TriggerMenuItem } from "@/components/composer/trigger-menu";

const LONG =
  "Plan and run a database schema migration end to end: read the current schema, write the forward and backward migration files, run them against a scratch copy, and report anything that would lock a large table.";

const menu = (items: ReadonlyArray<TriggerMenuItem>) =>
  renderToStaticMarkup(
    <TriggerMenu
      items={items}
      activeIndex={0}
      onSelect={() => {}}
      onHover={() => {}}
      emptyLabel="No skills"
      label="Skills"
    />,
  );

/** The class list of the `<span>` whose text is exactly `text`. */
const spanClass = (markup: string, text: string): string =>
  new RegExp(`<span class="([^"]*)">${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`).exec(
    markup,
  )?.[1] ?? "";

describe("TriggerMenu rows", () => {
  it("keeps the name's width and lets a long description take what is left", () => {
    const markup = menu([{ id: "skill:migrate", label: "migrate-database", description: LONG }]);
    const name = spanClass(markup, "migrate-database").split(" ");
    const description = spanClass(markup, LONG).split(" ");
    // The name sizes to itself and gives way only to its own ellipsis; the
    // description grows from nothing into the rest of the row and truncates.
    expect(name).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(name).not.toContain("flex-1");
    expect(description).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "truncate"]));
    expect(description).not.toContain("shrink-0");
  });

  it("puts the full description on the row's tooltip", () => {
    const markup = menu([{ id: "skill:migrate", label: "migrate-database", description: LONG }]);
    expect(markup).toContain(`title="${LONG}"`);
  });

  it("draws a row without a description as its name alone", () => {
    const markup = menu([{ id: "file:a", label: "a.ts" }]);
    expect(markup).not.toContain("title=");
    expect(markup.match(/<span/g)).toHaveLength(1);
  });
});
