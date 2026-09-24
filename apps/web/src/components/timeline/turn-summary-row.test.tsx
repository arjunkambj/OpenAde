import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PathChipsContext } from "@/components/timeline/path-chips";
import type { ConfirmedFile } from "@/components/timeline/path-links";
import { SummaryFile } from "@/components/timeline/turn-summary-row";

const absolute = "/Users/dev/repo/apps/web/src/components/timeline/fold.ts";
const file = { path: absolute, kind: "edit", added: 3, removed: 1 } as const;

const render = (confirmed: ReadonlyMap<string, ConfirmedFile>, onOpen: (() => void) | null) =>
  renderToStaticMarkup(
    <PathChipsContext.Provider value={confirmed}>
      <SummaryFile file={file} onOpen={onOpen} />
    </PathChipsContext.Provider>,
  );

describe("SummaryFile", () => {
  const confirmed = new Map<string, ConfirmedFile>([
    [
      absolute,
      { relativePath: "apps/web/src/components/timeline/fold.ts", absolutePath: absolute },
    ],
  ]);

  it("labels a confirmed path relative to the workspace, as the file-change rows do", () => {
    const html = render(confirmed, () => undefined);
    expect(html).toContain(">apps/web/src/components/timeline/fold.ts</span>");
    expect(html).not.toContain(`>${absolute}</span>`);
  });

  it("still opens the path the agent recorded in Changes", () => {
    expect(render(confirmed, () => undefined)).toContain(`title="Open ${absolute} in Changes"`);
  });

  it("shows the recorded path until the workspace confirms it", () => {
    expect(render(new Map(), null)).toContain(`>${absolute}</span>`);
  });
});
