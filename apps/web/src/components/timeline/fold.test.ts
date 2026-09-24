import type { ItemKind } from "@OpenAde/contracts/enums";
import { type ItemId, makeTurnId } from "@OpenAde/contracts/ids";
import type { ResolvedDecision } from "@OpenAde/contracts/decisions";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "vitest";

import { uuidV7Millis } from "@OpenAde/shared/ids";

import {
  buildTimeline,
  type TimelineDecisionRow,
  type TimelineTurnSummaryRow,
  type TimelineWorkGroupRow,
  type TimelineWorkingRow,
} from "./fold";

let sequence = 0;

/** A deterministic UUIDv7 with a controllable millisecond prefix. */
const itemIdAt = (millis: number): ItemId => {
  sequence += 1;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
};

let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  millis += 1_000;
  return { itemId: itemIdAt(millis), kind, status: "completed", ...over };
};

const workGroups = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineWorkGroupRow => row.kind === "work-group");

const summaries = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineTurnSummaryRow => row.kind === "turn-summary");

const edit = (path: string, diff: string, over: Partial<ItemSnapshot> = {}): ItemSnapshot =>
  item("file_change", { fileChange: { path, kind: "edit", diff }, ...over });

describe("buildTimeline", () => {
  it("passes a lone message exchange through untouched", () => {
    const items = [
      item("user_message", { text: "hi" }),
      item("assistant_message", { text: "hello" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
  });

  it("folds a settled turn's tool run into one work group", () => {
    const items = [
      item("user_message"),
      item("reasoning"),
      item("tool_call"),
      item("command_execution"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["item", "work-group", "item", "turn-summary"]);
    const group = workGroups(rows)[0];
    expect(group.items).toHaveLength(3);
  });

  it("keeps the live segment unfolded and appends a working row", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("tool_call"),
    ];
    const { rows } = buildTimeline(items, { turnActive: true });
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "work-group",
      "item",
      "turn-summary",
      "item",
      "item",
      "working",
    ]);
  });

  it("splits a settled run around a non-foldable row", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("context_compaction"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "work-group",
      "item",
      "work-group",
      "item",
      "turn-summary",
    ]);
    const groups = workGroups(rows);
    expect(groups.map((group) => group.items.length)).toEqual([1, 1]);
  });

  it("nests task children under the parent and keeps orphans at top level", () => {
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const orphan = item("tool_call", { parentItemId: itemIdAt(1) });
    const { rows, childrenByParent } = buildTimeline([task, child, orphan], {
      turnActive: false,
    });
    expect(childrenByParent.get(task.itemId)?.map((i) => i.itemId)).toEqual([child.itemId]);
    // task and orphan form one settled run; the child is not a top-level row
    expect(rows).toHaveLength(1);
    expect(workGroups(rows)[0].items.map((i) => i.itemId)).toEqual([task.itemId, orphan.itemId]);
  });

  it("derives the group's duration from the UUIDv7 item ids", () => {
    const items = [item("user_message"), item("tool_call"), item("tool_call")];
    const group = workGroups(buildTimeline(items, { turnActive: false }).rows)[0];
    expect(group.durationMs).toBe(1_000);
  });

  it("reports failures in the folded group", () => {
    const items = [
      item("user_message"),
      item("command_execution", { status: "failed" }),
      item("tool_call"),
    ];
    const group = workGroups(buildTimeline(items, { turnActive: false }).rows)[0];
    expect(group.failedCount).toBe(1);
  });

  it("folds items that precede the first user message", () => {
    const items = [item("reasoning"), item("tool_call"), item("assistant_message")];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["work-group", "item"]);
  });
});

describe("buildTimeline turn summaries", () => {
  it("ends a settled turn with one summary of its time, files and line counts", () => {
    const user = item("user_message");
    const items = [
      user,
      item("tool_call"),
      edit("src/a.ts", "@@ -1,2 +1,3 @@\n-old\n+new\n+more"),
      item("file_change", { fileChange: { path: "src/b.ts", kind: "create", diff: "+x" } }),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows[rows.length - 1].kind).toBe("turn-summary");
    const [summary] = summaries(rows);
    expect(summaries(rows)).toHaveLength(1);
    expect(summary.id).toBe(`turn-summary:${user.itemId}`);
    expect(summary.durationMs).toBe(4_000);
    expect(summary.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it("merges repeated paths into one entry", () => {
    const items = [
      item("user_message"),
      item("file_change", { fileChange: { path: "src/a.ts", kind: "create", diff: "+one" } }),
      edit("src/a.ts", "+two\n-one"),
      edit("src/a.ts", "+three", { status: "failed" }),
    ];
    const [summary] = summaries(buildTimeline(items, { turnActive: false }).rows);
    expect(summary.files).toEqual([{ path: "src/a.ts", kind: "create", added: 3, removed: 1 }]);
    expect(summary.failedCount).toBe(1);
  });

  it("counts file changes and time nested under a task", () => {
    const user = item("user_message");
    const task = item("task");
    const inner = item("task", { parentItemId: task.itemId });
    const change = edit("src/deep.ts", "+a\n+b", { parentItemId: inner.itemId });
    const [summary] = summaries(
      buildTimeline([user, task, inner, change], { turnActive: false }).rows,
    );
    expect(summary.files).toEqual([{ path: "src/deep.ts", kind: "edit", added: 2, removed: 0 }]);
    // the nested change is the turn's last item
    expect(summary.durationMs).toBe(3_000);
  });

  it("reports no files when the turn changed none", () => {
    const items = [item("user_message"), item("command_execution")];
    const [summary] = summaries(buildTimeline(items, { turnActive: false }).rows);
    expect(summary.files).toEqual([]);
    expect(summary.added + summary.removed).toBe(0);
  });

  it("leaves out turns without work, the live turn and a leading segment", () => {
    const plain = [item("user_message"), item("assistant_message")];
    expect(summaries(buildTimeline(plain, { turnActive: false }).rows)).toEqual([]);

    const live = [item("user_message"), item("tool_call")];
    expect(summaries(buildTimeline(live, { turnActive: true }).rows)).toEqual([]);

    const leading = [item("tool_call"), item("assistant_message")];
    expect(summaries(buildTimeline(leading, { turnActive: false }).rows)).toEqual([]);
  });

  it("names the checkpoint its turn left, and nothing for a turn without one", () => {
    const first = makeTurnId();
    const second = makeTurnId();
    const items = [
      item("user_message", { turnId: first }),
      edit("a.ts", "+a", { turnId: first }),
      item("user_message", { turnId: second }),
      edit("b.ts", "+b", { turnId: second }),
      // A turn from before turn ids were recorded.
      item("user_message"),
      edit("c.ts", "+c"),
    ];
    const checkpoints = [{ turnId: first, ref: "refs/openade/checkpoints/t/1" }];
    const rows = summaries(buildTimeline(items, { turnActive: false, checkpoints }).rows);
    expect(rows.map((summary) => summary.checkpointRef)).toEqual([
      "refs/openade/checkpoints/t/1",
      undefined,
      undefined,
    ]);
  });

  it("drops a duration the ids cannot measure", () => {
    const user = item("user_message");
    // two items in one millisecond: no measurable time
    const sameMs: ItemSnapshot = {
      itemId: itemIdAt(millis),
      kind: "tool_call",
      status: "completed",
    };
    const [summary] = summaries(buildTimeline([user, sameMs], { turnActive: false }).rows);
    expect(summary.durationMs).toBeUndefined();
  });
});

describe("buildTimeline working row", () => {
  const working = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
    rows.find((row): row is TimelineWorkingRow => row.kind === "working");

  it("starts the clock at the turn's own start when it is known", () => {
    const items = [item("user_message"), item("tool_call")];
    const { rows } = buildTimeline(items, { turnActive: true, turnStartedAt: 1_234 });
    expect(working(rows)?.startedAt).toBe(1_234);
  });

  it("falls back to the last user message before the turn id is filled in", () => {
    const first = item("user_message");
    const reply = item("assistant_message");
    const second = item("user_message");
    const { rows } = buildTimeline([first, reply, second, item("reasoning")], {
      turnActive: true,
    });
    expect(working(rows)?.startedAt).toBe(uuidV7Millis(second.itemId));
    expect(working(rows)?.startedAt).toBeGreaterThan(uuidV7Millis(first.itemId) ?? 0);
  });

  it("leaves the start unknown when nothing carries a time", () => {
    const { rows } = buildTimeline([item("assistant_message")], { turnActive: true });
    expect(working(rows)?.startedAt).toBeUndefined();
  });

  it("adds no working row once the turn has settled", () => {
    const { rows } = buildTimeline([item("user_message")], {
      turnActive: false,
      turnStartedAt: 1_234,
    });
    expect(working(rows)).toBeUndefined();
  });
});

describe("buildTimeline decisions", () => {
  const decision = (over: Partial<ResolvedDecision> = {}): ResolvedDecision => ({
    kind: "approval",
    id: "req-1",
    outcome: "allow-once",
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  const labels = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
    rows.map((row) =>
      row.kind === "item"
        ? row.item.kind
        : row.kind === "decision"
          ? `decision:${row.decision.id}`
          : row.kind,
    );

  it("places a record right after the row holding its anchor", () => {
    const user = item("user_message");
    const reply = item("assistant_message");
    const { rows } = buildTimeline([user, reply, item("user_message")], {
      turnActive: true,
      decisions: [decision({ afterItemId: user.itemId })],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "decision:req-1",
      "assistant_message",
      "user_message",
      "working",
    ]);
    const row = rows[1] as TimelineDecisionRow;
    expect(row.id).toBe("decision:req-1");
    expect(row.decision.outcome).toBe("allow-once");
  });

  it("splits a settled work run into two groups around the record", () => {
    const first = item("tool_call");
    const items = [
      item("user_message"),
      item("reasoning"),
      first,
      item("command_execution"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, {
      turnActive: false,
      decisions: [decision({ afterItemId: first.itemId })],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "decision:req-1",
      "work-group",
      "assistant_message",
      "turn-summary",
    ]);
    expect(workGroups(rows).map((group) => group.items.length)).toEqual([2, 2]);
    // the record splits the groups but not the turn: one summary still covers it
    expect(summaries(rows)).toHaveLength(1);
  });

  it("anchors a task child's record after the task", () => {
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const { rows } = buildTimeline([item("user_message"), task, child, item("tool_call")], {
      turnActive: false,
      decisions: [decision({ afterItemId: child.itemId })],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "decision:req-1",
      "work-group",
      "turn-summary",
    ]);
    expect(workGroups(rows)[0].items.map((i) => i.itemId)).toEqual([task.itemId]);
  });

  it("puts a record with an unknown or missing anchor at the end, before the working row", () => {
    const { rows } = buildTimeline([item("user_message"), item("tool_call")], {
      turnActive: true,
      decisions: [
        decision({ id: "req-1", afterItemId: itemIdAt(1) }),
        decision({ id: "req-2", kind: "question", outcome: "answered" }),
      ],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "tool_call",
      "decision:req-1",
      "decision:req-2",
      "working",
    ]);
  });

  it("keeps row ids unique when two records share an id", () => {
    const user = item("user_message");
    const { rows } = buildTimeline([user], {
      turnActive: false,
      decisions: [
        decision({ kind: "plan", id: "turn-1", outcome: "revise", afterItemId: user.itemId }),
        decision({ kind: "plan", id: "turn-1", outcome: "accept", afterItemId: user.itemId }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual([
      user.itemId,
      "decision:turn-1",
      "decision:turn-1:2",
    ]);
  });

  it("leaves today's rows unchanged without decisions", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("reasoning"),
    ];
    for (const turnActive of [false, true]) {
      const plain = buildTimeline(items, { turnActive });
      expect(buildTimeline(items, { turnActive, decisions: [] })).toEqual(plain);
      expect(buildTimeline(items, { turnActive, decisions: undefined })).toEqual(plain);
    }
  });
});

describe("buildTimeline turn ends", () => {
  const ends = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
    rows.flatMap((row) =>
      row.kind === "item" && row.turnEnd !== undefined ? [{ id: row.id, ...row.turnEnd }] : [],
    );
  const turnA = makeTurnId();
  const turnB = makeTurnId();

  it("marks the last assistant message of each settled turn only", () => {
    const userA = item("user_message", { turnId: turnA });
    const narration = item("assistant_message", { turnId: turnA });
    const tool = item("tool_call", { turnId: turnA });
    const answerA = item("assistant_message", { turnId: turnA });
    const userB = item("user_message", { turnId: turnB });
    const answerB = item("assistant_message", { turnId: turnB });
    const { rows } = buildTimeline([userA, narration, tool, answerA, userB, answerB], {
      turnActive: false,
    });
    expect(ends(rows)).toEqual([
      {
        id: answerA.itemId,
        turnId: turnA,
        durationMs: uuidV7Millis(answerA.itemId)! - uuidV7Millis(userA.itemId)!,
      },
      {
        id: answerB.itemId,
        turnId: turnB,
        durationMs: uuidV7Millis(answerB.itemId)! - uuidV7Millis(userB.itemId)!,
      },
    ]);
  });

  it("marks none in the live turn", () => {
    const userA = item("user_message", { turnId: turnA });
    const answerA = item("assistant_message", { turnId: turnA });
    const userB = item("user_message", { turnId: turnB });
    const interim = item("assistant_message", { turnId: turnB });
    const { rows } = buildTimeline([userA, answerA, userB, interim, item("tool_call")], {
      turnActive: true,
    });
    expect(ends(rows).map((end) => end.id)).toEqual([answerA.itemId]);
  });

  it("ends a steered turn at its last segment, timed from its first", () => {
    const user = item("user_message", { turnId: turnA });
    const before = item("assistant_message", { turnId: turnA });
    const steer = item("user_message", { turnId: turnA });
    const answer = item("assistant_message", { turnId: turnA });
    const settled = buildTimeline([user, before, steer, answer], { turnActive: false });
    expect(ends(settled.rows)).toEqual([
      {
        id: answer.itemId,
        turnId: turnA,
        durationMs: uuidV7Millis(answer.itemId)! - uuidV7Millis(user.itemId)!,
      },
    ]);
    // Steered into the running turn: the earlier segment is not the end either.
    expect(ends(buildTimeline([user, before, steer], { turnActive: true }).rows)).toEqual([]);
  });

  it("counts task children in the time and skips turns without an answer", () => {
    const user = item("user_message");
    const task = item("task");
    const answer = item("assistant_message");
    const late = item("tool_call", { parentItemId: task.itemId });
    const quiet = [item("user_message"), item("tool_call")];
    const { rows } = buildTimeline([user, task, answer, late, ...quiet], { turnActive: false });
    expect(ends(rows)).toEqual([
      {
        id: answer.itemId,
        turnId: undefined,
        durationMs: uuidV7Millis(late.itemId)! - uuidV7Millis(user.itemId)!,
      },
    ]);
  });

  it("gives an answer before the first user message no end", () => {
    const { rows } = buildTimeline([item("assistant_message"), item("tool_call")], {
      turnActive: false,
    });
    expect(ends(rows)).toEqual([]);
  });
});
