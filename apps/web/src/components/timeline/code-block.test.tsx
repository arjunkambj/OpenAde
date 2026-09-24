import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CodeBlock } from "@/components/timeline/code-block";
import { MarkdownBody } from "@/components/timeline/markdown";

// A pool in context, and a `File` that shows what it was asked to draw: the
// library's own element needs a browser and a worker.
vi.mock("@pierre/diffs/react", () => ({
  useWorkerPool: () => ({}),
  File: ({
    file,
    className,
  }: {
    readonly file: { readonly lang: string; readonly contents: string };
    readonly className?: string;
  }): React.ReactElement => (
    <div data-lang={file.lang} className={className}>
      {file.contents}
    </div>
  ),
}));

const info = { language: "typescript", label: "TypeScript" } as const;

describe("CodeBlock with a worker pool", () => {
  it("lays scrolling code out at its full width, so the capped box scrolls both ways", () => {
    const markup = renderToStaticMarkup(<CodeBlock code="const a = 1;" info={info} />);
    expect(markup).toMatch(/<div class="max-h-96 overflow-auto"><div data-lang="typescript"/);
    expect(markup).toMatch(/data-lang="typescript" class="block text-xs w-max min-w-full"/);
  });

  it("highlights a closed fence and keeps one still streaming plain", () => {
    const closed = renderToStaticMarkup(
      <MarkdownBody
        text={"Steps:\n\n- a\n  - b\n    ```ts\n    const x = 1;\n    ```"}
        streaming
      />,
    );
    expect(closed).toContain('data-lang="typescript"');
    // A fence nested four spaces deep in a list, its closing fence not here yet.
    const open = renderToStaticMarkup(
      <MarkdownBody text={"Steps:\n\n- a\n  - b\n    ```ts\n    const x = 1;"} streaming />,
    );
    expect(open).toContain('data-lang="text"');
    expect(open).not.toContain('data-lang="typescript"');
    const quoted = renderToStaticMarkup(
      <MarkdownBody text={"> ```ts\n> const z = 1;"} streaming />,
    );
    expect(quoted).toContain('data-lang="text"');
  });
});
