import { makeItemId } from "@OpenAde/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineTurnFoldRow } from "@/components/timeline/fold";
import { TurnFoldRow } from "@/components/timeline/turn-fold-row";

describe("TurnFoldRow", () => {
  const fold = (fields: Partial<TimelineTurnFoldRow> = {}): TimelineTurnFoldRow => ({
    kind: "turn-fold",
    id: `turn-fold:${makeItemId()}`,
    durationMs: 123_000,
    sentence: "Ran 3 commands, edited 2 files",
    failedCount: 0,
    ...fields,
  });

  it("reads as how long the turn worked and what it did, closed", () => {
    const markup = renderToStaticMarkup(<TurnFoldRow row={fold()} />);
    expect(markup).toContain(">Worked for 2m 3s · Ran 3 commands, edited 2 files<");
    expect(markup).toContain('aria-expanded="false"');
    // the rows it opens are the list's own: the fold has no panel
    expect(markup).not.toContain('data-slot="collapsible-content"');
  });

  it("notes failures beside the label", () => {
    const markup = renderToStaticMarkup(<TurnFoldRow row={fold({ failedCount: 2 })} />);
    expect(markup).toContain(">2 failed<");
    expect(markup).toContain(
      'title="Worked for 2m 3s · Ran 3 commands, edited 2 files · 2 failed"',
    );
  });
});
