import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/timeline/markdown";
import { PathChip, PathChipsContext } from "@/components/timeline/path-chips";
import { type ConfirmedFile, confirmedFiles } from "@/components/timeline/path-links";

const ROOT = "/work/repo";

/** What `files.stat` would confirm for these paths as asked. */
const confirm = (asked: Record<string, string>): ReadonlyMap<string, ConfirmedFile> =>
  confirmedFiles(
    Object.entries(asked).map(([path, relativePath]) => ({
      path,
      relativePath,
      absolutePath: `${ROOT}/${relativePath}`,
      isDirectory: false,
    })),
  );

// No timeline thread is in context here, so `MarkdownBody` asks nothing and
// reads whatever answer the test provides around it.
const render = (text: string, files: ReadonlyMap<string, ConfirmedFile> = new Map()) =>
  renderToStaticMarkup(
    <PathChipsContext.Provider value={files}>
      <MarkdownBody text={text} id="item" />
    </PathChipsContext.Provider>,
  );

describe("file paths in an agent message", () => {
  it("keeps an unconfirmed inline path as plain code, with no chip", () => {
    const markup = render("Edit `src/app.ts:12` next.");
    expect(markup).toContain(">src/app.ts:12</code>");
    expect(markup).not.toContain("<button");
  });

  it("renders a confirmed inline path as a chip with its line", () => {
    const markup = render("Edit `src/app.ts:12` next.", confirm({ "src/app.ts": "src/app.ts" }));
    expect(markup).not.toContain("<code");
    expect(markup).toContain('aria-label="Open src/app.ts:12"');
    expect(markup).toContain(">app.ts</span>");
    expect(markup).toContain(">:12</span>");
  });

  it("renders a confirmed link as a chip at the line its fragment names", () => {
    const markup = render(
      "See [the readme](README.md#L3-L9).",
      confirm({ "README.md": "README.md" }),
    );
    expect(markup).not.toContain("<a ");
    expect(markup).toContain('aria-label="Open README.md:3–9"');
  });

  it("confirms an absolute link by the path it was asked as, showing it relative", () => {
    const markup = render(
      "The RPC is [rpc.ts](/work/repo/packages/contracts/src/rpc.ts:40).",
      confirm({ "/work/repo/packages/contracts/src/rpc.ts": "packages/contracts/src/rpc.ts" }),
    );
    expect(markup).toContain('aria-label="Open packages/contracts/src/rpc.ts:40"');
  });

  it("renders an unconfirmed path link as its text, never as a link to the app", () => {
    const markup = render("Not here: [hosts](/etc/hosts) or [main](src/main.tsx:4).");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("<button");
    expect(markup).toContain("Not here: hosts or main.");
  });

  it("keeps a web link a link", () => {
    const markup = render("Read [the docs](https://example.com/docs).", confirm({}));
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('target="_blank"');
  });

  it("never turns a non-path code span into a chip, whatever the answer holds", () => {
    const markup = render("Run `npm test`.", confirm({ "npm test": "npm test" }));
    expect(markup).toContain(">npm test</code>");
  });

  it("tells two chips with one name apart by their parent folder", () => {
    const markup = render(
      "Both `apps/web/src/lib/format.ts` and `packages/shared/src/format.ts`.",
      confirm({
        "apps/web/src/lib/format.ts": "apps/web/src/lib/format.ts",
        "packages/shared/src/format.ts": "packages/shared/src/format.ts",
      }),
    );
    expect(markup).toContain(">lib/</span>format.ts");
    expect(markup).toContain(">src/</span>format.ts");
  });

  it("leaves the user variant's paths as typed", () => {
    const markup = renderToStaticMarkup(
      <PathChipsContext.Provider value={confirm({ "src/app.ts": "src/app.ts" })}>
        <MarkdownBody text="Look at `src/app.ts`." variant="user" />
      </PathChipsContext.Provider>,
    );
    expect(markup).toContain(">src/app.ts</code>");
  });
});

describe("PathChip", () => {
  it("shows the fallback until the path is confirmed, then the whole relative path", () => {
    const fallback = <span>/work/repo/src/app.ts</span>;
    expect(
      renderToStaticMarkup(<PathChip path="/work/repo/src/app.ts" fallback={fallback} />),
    ).toBe("<span>/work/repo/src/app.ts</span>");
    const markup = renderToStaticMarkup(
      <PathChipsContext.Provider value={confirm({ "/work/repo/src/app.ts": "src/app.ts" })}>
        <PathChip path="/work/repo/src/app.ts" fallback={fallback} />
      </PathChipsContext.Provider>,
    );
    expect(markup).toContain('aria-label="Open src/app.ts"');
    expect(markup).toContain(">src/app.ts</span>");
  });
});
