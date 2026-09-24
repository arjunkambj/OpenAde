import type { ItemSnapshot, Todo } from "@poseidon/contracts/runtime";
import { makeItemId } from "@poseidon/contracts/ids";
import { Check, Close, Hammer, Minus, PlayMini } from "@honeyicons/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodoRow } from "@/components/timeline/todo-row";
import { ToolCallRow } from "@/components/timeline/tool-rows";

/** An icon's path data, which tells one glyph from another whatever its classes. */
const glyph = (element: ReactElement) => {
  const paths =
    renderToStaticMarkup(element)
      .match(/<path [^>]*>/g)
      ?.join("") ?? "";
  if (paths === "") {
    throw new Error("the icon drew no path");
  }
  return paths;
};

const svgs = (markup: string) => markup.match(/<svg[\s\S]*?<\/svg>/g) ?? [];

const todoRow = (todos: ReadonlyArray<Todo>): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "todo",
  status: "completed",
  todos: [...todos],
});

describe("TodoRow", () => {
  const markup = renderToStaticMarkup(
    <TodoRow
      item={todoRow([
        { todoId: "a", text: "Read the router", status: "completed" },
        { todoId: "b", text: "Add the endpoint", status: "in_progress" },
        { todoId: "c", text: "Write the tests", status: "pending" },
      ])}
    />,
  );
  const [done, current, pending] = svgs(markup);

  it("draws a different mark for each status", () => {
    expect(svgs(markup)).toHaveLength(3);
    expect(done).toContain(glyph(<Check variant="bold" />));
    expect(current).toContain(glyph(<PlayMini variant="bold" />));
    expect(pending).toContain(glyph(<Minus variant="bold" />));
    const shapes = [done, current, pending].map((svg) => svg?.match(/<path [^>]*>/g)?.join(""));
    expect(new Set(shapes).size).toBe(3);
  });

  it("never uses the close mark, which reads as failed", () => {
    expect(markup).not.toContain(glyph(<Close variant="bold" />));
  });

  it("keeps the status tones", () => {
    expect(done).toContain("text-added");
    expect(current).toContain("text-permission");
    expect(pending).toContain("text-muted-foreground");
  });
});

describe("ToolCallRow", () => {
  it("marks a generic tool with a hammer", () => {
    const markup = renderToStaticMarkup(
      <ToolCallRow
        item={{
          itemId: makeItemId(),
          kind: "tool_call",
          status: "completed",
          tool: { name: "lookup_symbol", input: { symbol: "Router" } },
        }}
      />,
    );
    expect(markup).toContain(glyph(<Hammer variant="bold" />));
    expect(markup).not.toContain(glyph(<Close variant="bold" />));
  });
});
