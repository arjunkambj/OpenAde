import {
  makeCheckpointId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
  type TurnId,
} from "@OpenAde/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineTurnFoldRow, TimelineTurnSummaryRow } from "@/components/timeline/fold";
import { type TimelineThread, TimelineThreadProvider } from "@/components/timeline/thread-context";
import { TurnFoldRow } from "@/components/timeline/turn-fold-row";
import { TurnSummaryRow } from "@/components/timeline/turn-summary-row";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";

const [t1, t2] = [makeTurnId(), makeTurnId()];

const summary = (fileCount: number, turnId: TurnId = t2): TimelineTurnSummaryRow => ({
  kind: "turn-summary",
  id: `turn-summary:${makeItemId()}`,
  turnId,
  files: Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${index}.ts`,
    kind: "edit" as const,
    added: 2,
    removed: 1,
  })),
  added: 2 * fileCount,
  removed: fileCount,
  checkpointRef: undefined,
});

const thread = (fields: Partial<TimelineThread> = {}): TimelineThread => ({
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  checkpoints: [
    {
      checkpointId: makeCheckpointId(),
      turnId: t1,
      ref: `refs/openade/checkpoints/t/${t1}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  restoreBlockedReason: null,
  turnOrder: [t1, t2],
  ...fields,
});

const render = (row: TimelineTurnSummaryRow, value?: TimelineThread) =>
  renderToStaticMarkup(
    <ClientRuntimeProvider layer={makeFixtureClient().layer}>
      {value === undefined ? (
        <TurnSummaryRow summary={row} />
      ) : (
        <TimelineThreadProvider value={value}>
          <TurnSummaryRow summary={row} />
        </TimelineThreadProvider>
      )}
    </ClientRuntimeProvider>,
  );

describe("TurnSummaryRow", () => {
  it("titles the card with the files and counts, and leaves the time to the fold", () => {
    const markup = render(summary(3));
    expect(markup).toContain("Changed 3 files");
    expect(markup).toContain(">+6<");
    expect(markup).toContain(">−3<");
    expect(markup).not.toContain("Worked");
  });

  it("lists five files, then offers the rest", () => {
    const markup = render(summary(7));
    expect(markup.match(/<li/g)).toHaveLength(5);
    expect(markup).toContain("src/file-4.ts");
    expect(markup).not.toContain("src/file-5.ts");
    expect(markup).toContain("Show 2 more");
    expect(markup).toMatch(/aria-expanded="false"[^>]*>.*Show 2 more/);
  });

  it("offers no more when five or fewer files changed", () => {
    const markup = render(summary(5));
    expect(markup.match(/<li/g)).toHaveLength(5);
    expect(markup).not.toContain("more</button>");
  });

  it("offers Undo when a checkpoint precedes the turn", () => {
    const markup = render(summary(1), thread());
    expect(markup).toMatch(/<button[^>]*>.*Undo<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Undo<\/button>/);
    expect(markup).toContain("Open in Changes");
  });

  it("has no Undo outside a timeline, on the first turn or without a checkpoint", () => {
    expect(render(summary(1))).not.toContain("Undo");
    expect(render(summary(1, t1), thread())).not.toContain("Undo");
    expect(render(summary(1), thread({ checkpoints: [] }))).not.toContain("Undo");
  });

  it("disables Undo while a restore cannot start", () => {
    const markup = render(summary(1), thread({ restoreBlockedReason: "A turn is running" }));
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Undo<\/button>/);
  });
});

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
