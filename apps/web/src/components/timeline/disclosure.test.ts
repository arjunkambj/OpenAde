import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import type { ResolvedDecision } from "@OpenAde/contracts/decisions";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "vitest";

import { disclosureIds } from "./disclosure";
import { buildTimeline } from "./fold";

let sequence = 0;
let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  sequence += 1;
  millis += 1_000;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  const itemId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
  return { itemId, kind, status: "completed", ...over };
};

const decision: ResolvedDecision = {
  kind: "approval",
  id: "req-1",
  outcome: "allow-once",
  resolvedAt: "2026-01-01T00:00:00.000Z",
};

describe("disclosureIds", () => {
  it("lists tool rows and plans in a live turn, and skips messages and the working row", () => {
    const user = item("user_message");
    const reasoning = item("reasoning");
    const command = item("command_execution");
    const change = item("file_change", { fileChange: { path: "a.ts", kind: "edit", diff: "" } });
    const mcp = item("mcp_tool_call");
    const search = item("web_search");
    const plan = item("plan", { text: "1. do it" });
    const todo = item("todo");
    const skill = item("skill");
    const reply = item("assistant_message");
    const projection = buildTimeline(
      [user, reasoning, command, change, mcp, search, plan, todo, skill, reply],
      { turnActive: true },
    );
    expect(disclosureIds(projection)).toEqual([
      reasoning.itemId,
      command.itemId,
      change.itemId,
      mcp.itemId,
      search.itemId,
      plan.itemId,
    ]);
  });

  it("lists a settled turn's work group, the rows folded in it and its summary", () => {
    const user = item("user_message");
    const tool = item("tool_call");
    const command = item("command_execution");
    const reply = item("assistant_message");
    const projection = buildTimeline([user, tool, command, reply], { turnActive: false });
    const group = projection.rows.find((row) => row.kind === "work-group");
    const summary = projection.rows.find((row) => row.kind === "turn-summary");
    expect(disclosureIds(projection)).toEqual([
      group?.id,
      tool.itemId,
      command.itemId,
      summary?.id,
    ]);
  });

  it("walks into a task's children at any depth", () => {
    const user = item("user_message");
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const inner = item("task", { parentItemId: task.itemId });
    const grandchild = item("command_execution", { parentItemId: inner.itemId });
    const note = item("assistant_message", { parentItemId: task.itemId });
    const projection = buildTimeline([user, task, child, inner, grandchild, note], {
      turnActive: true,
    });
    expect(disclosureIds(projection)).toEqual([
      task.itemId,
      child.itemId,
      inner.itemId,
      grandchild.itemId,
    ]);
  });

  it("lists answered decisions by their row id", () => {
    const user = item("user_message");
    const projection = buildTimeline([user], {
      turnActive: false,
      decisions: [decision, decision],
    });
    expect(disclosureIds(projection)).toEqual(["decision:req-1", "decision:req-1:2"]);
  });

  it("lists nothing for a plain exchange", () => {
    const projection = buildTimeline([item("user_message"), item("assistant_message")], {
      turnActive: false,
    });
    expect(disclosureIds(projection)).toEqual([]);
  });
});
