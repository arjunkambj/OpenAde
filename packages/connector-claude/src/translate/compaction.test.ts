/**
 * The compaction row's own lifecycle and its line. The CLI's `compacting`
 * status and `compact_boundary` are proven on the real CLI's recordings, in
 * `recordedFrames.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  COMPACTING,
  COMPACTION_FAILED,
  COMPACTION_UNFINISHED,
  compactedText,
  makeCompaction,
} from "./compaction";

describe("compactedText", () => {
  it("names the size before and after", () => {
    expect(compactedText({ trigger: "manual", pre_tokens: 120_500, post_tokens: 8_200 })).toBe(
      "Context compacted: 120,500 → 8,200 tokens",
    );
  });

  it("names the size before alone when that is all the CLI said", () => {
    expect(compactedText({ trigger: "auto", pre_tokens: 90_000 })).toBe(
      "Context compacted from 90,000 tokens",
    );
  });

  it("says only that it happened otherwise", () => {
    expect(compactedText({})).toBe("Context compacted");
  });
});

describe("a compaction row", () => {
  it("opens once however often the CLI says it is compacting", () => {
    const compaction = makeCompaction();
    const opened = compaction.compacting();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: "item.started",
      payload: { item: { kind: "context_compaction", status: "in_progress", text: COMPACTING } },
    });
    expect(compaction.compacting()).toEqual([]);
  });

  it("is failed when the turn ends under it, and only once", () => {
    const compaction = makeCompaction();
    expect(compaction.abandon()).toEqual([]);
    const [opened] = compaction.compacting();
    const failed = compaction.abandon();
    expect(failed).toEqual([
      {
        itemId: opened!.type === "item.started" ? opened!.payload.item.itemId : undefined,
        type: "item.completed",
        payload: {
          item: expect.objectContaining({
            kind: "context_compaction",
            status: "failed",
            text: "Context not compacted",
            error: { message: COMPACTION_UNFINISHED },
          }),
        },
      },
    ]);
    expect(compaction.abandon()).toEqual([]);
  });

  it("fails with the CLI's own line when the CLI says the compaction failed", () => {
    const compaction = makeCompaction();
    expect(compaction.statusCleared({ compact_result: "failed" })).toEqual([]);
    compaction.compacting();
    expect(compaction.statusCleared({ compact_result: "success" })).toEqual([]);
    const [failed] = compaction.statusCleared({
      compact_result: "failed",
      compact_error: "No room",
    });
    expect(failed?.type === "item.completed" && failed.payload.item).toMatchObject({
      status: "failed",
      error: { message: "No room" },
    });
    compaction.compacting();
    const [unexplained] = compaction.statusCleared({ compact_result: "failed" });
    expect(unexplained?.type === "item.completed" && unexplained.payload.item.error).toEqual({
      message: COMPACTION_FAILED,
    });
    expect(compaction.abandon()).toEqual([]);
  });
});
