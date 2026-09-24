/**
 * The pieces a subagent's row is built from: how a task's state reads as a
 * row's status, the title a Task or Agent call gives its task, and the hold
 * that keeps a subagent's messages until its task's row is open. How the
 * SDK's own messages become nested rows is proven on the real CLI's
 * recordings, in `recordedFrames.test.ts` and `recordedSession.test.ts`.
 */

import { makeItemId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "vitest";

import { makeSubagents, settledTaskStatus, taskTitleOf, UNTITLED_TASK } from "./subagents";

describe("settledTaskStatus", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["killed", "failed"],
    ["stopped", "failed"],
    ["running", null],
    ["pending", null],
    ["paused", null],
    [undefined, null],
  ] as const)("reads %s as %s", (status, settled) => {
    expect(settledTaskStatus(status)).toBe(settled);
  });
});

describe("taskTitleOf", () => {
  it("is the call's description", () => {
    expect(taskTitleOf({ description: "  List the files ", subagent_type: "Explore" })).toBe(
      "List the files",
    );
  });

  it("names the subagent's kind when there is no description", () => {
    expect(taskTitleOf({ description: "", subagent_type: "general-purpose" })).toBe(
      "general-purpose subagent",
    );
  });

  it("falls back to a plain title", () => {
    expect(taskTitleOf({})).toBe(UNTITLED_TASK);
  });
});

describe("the hold", () => {
  const first = { n: 1 };
  const second = { n: 2 };
  const other = { n: 3 };

  it("keeps each call's messages, in order, until its row is open", () => {
    const subagents = makeSubagents();
    subagents.hold("call-a", first);
    subagents.hold("call-b", other);
    subagents.hold("call-a", second);

    expect(subagents.takeReady(() => undefined)).toEqual([]);
    const open = new Set(["call-a"]);
    const rowOf = (id: string) =>
      open.has(id) ? { itemId: makeItemId(), kind: "task" } : undefined;
    expect(subagents.takeReady(rowOf)).toEqual([
      { toolUseId: "call-a", message: first },
      { toolUseId: "call-a", message: second },
    ]);
    // Taken once: the same call is not released twice.
    expect(subagents.takeReady(rowOf)).toEqual([]);
    expect(subagents.takeAll()).toEqual([other]);
  });

  it("lets go of everything at the end of the turn", () => {
    const subagents = makeSubagents();
    subagents.hold("call-a", first);
    subagents.hold("call-b", second);
    expect(subagents.takeAll()).toEqual([first, second]);
    expect(subagents.takeAll()).toEqual([]);
  });
});

describe("a task's start", () => {
  it("is announced once, with the call's title and model, under its parent task", () => {
    const subagents = makeSubagents();
    const itemId = makeItemId();
    const parent = makeItemId();
    const input = {
      description: "List the files",
      subagent_type: "general-purpose",
      model: "haiku",
    };
    expect(subagents.opened("call-a", itemId, input, parent)).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: itemId,
          title: "List the files",
          status: "in_progress",
          parentItemId: parent,
          model: "haiku",
        },
      },
    ]);
    expect(subagents.opened("call-a", itemId, input, parent)).toEqual([]);
  });
});

describe("a task's lifecycle", () => {
  /** Never read: a call with no task row is refused before its message is. */
  const message = { n: 1 };

  it("reads nothing of a call whose row is not a task's, for the translator to keep unmapped", () => {
    // A background shell command's task_* messages name its Bash call.
    expect(makeSubagents().lifecycle("call-bash", message)).toBeNull();
  });
});
