import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { FileChangeKind, ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  countFailed,
  turnFoldLabel,
  withFailures,
  workClauses,
  workGroupLabel,
  workSentence,
} from "./work-summary";

let sequence = 0;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  sequence += 1;
  const itemId = `0189c3a4-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}` as ItemId;
  return { itemId, kind, status: "completed", ...over };
};

const run = (status: ItemSnapshot["status"] = "completed") =>
  item("command_execution", { status, command: { cmd: "pnpm test" } });

const file = (path: string, kind: FileChangeKind = "edit") =>
  item("file_change", { fileChange: { path, kind } });

const call = (name: string, input: Record<string, unknown> = {}, kind: ItemKind = "tool_call") =>
  item(kind, { tool: { name, input } });

describe("workSentence", () => {
  it("says what the work did, first clause capitalised, joined with commas", () => {
    const items = [
      run(),
      file("src/a.ts"),
      run(),
      call("read_file", { file_path: "src/a.ts" }),
      file("src/b.ts"),
      call("Read", { file_path: "src/c.ts" }),
      run(),
    ];
    expect(workSentence(items)).toBe("Ran 3 commands, edited 2 files, read 2 files");
  });

  it("pluralises by count", () => {
    expect(workSentence([run()])).toBe("Ran 1 command");
    expect(workSentence([file("a.ts", "create"), file("b.ts", "create")])).toBe("Created 2 files");
    expect(workSentence([call("grep", { pattern: "x" })])).toBe("Searched once");
    expect(workSentence([call("grep", { pattern: "x" }), call("glob", { pattern: "*" })])).toBe(
      "Searched 2 times",
    );
    expect(workSentence([call("list_dir", { path: "src" })])).toBe("Listed 1 folder");
    expect(workSentence([item("task"), item("task")])).toBe("Ran 2 tasks");
    expect(workSentence([item("skill")])).toBe("Used 1 skill");
  });

  it("counts a file once per path, keeping a created file created", () => {
    const items = [file("a.ts", "create"), file("a.ts"), file("a.ts"), file("b.ts", "delete")];
    expect(workClauses(items)).toEqual([
      { kind: "create", count: 1 },
      { kind: "delete", count: 1 },
    ]);
    expect(workSentence(items)).toBe("Created 1 file, deleted 1 file");
    // the same file read twice is one file read
    const reads = [call("Read", { file_path: "a.ts" }), call("Read", { file_path: "a.ts" })];
    expect(workSentence(reads)).toBe("Read 1 file");
  });

  it("reads tools by the words in their name and the keys of their input", () => {
    expect(workSentence([call("readFile", { target: "a.ts" })])).toBe("Read 1 file");
    expect(workSentence([call("open_thing", { path: "a.ts" })])).toBe("Read 1 file");
    expect(workSentence([call("search_code", { path: "src", pattern: "x" })])).toBe(
      "Searched once",
    );
    expect(workSentence([call("lookup", { query: "x" })])).toBe("Searched once");
    expect(workSentence([call("Bash", { command: "ls" })])).toBe("Ran 1 command");
    expect(workSentence([call("str_replace", { file_path: "a.ts" })])).toBe("Edited 1 file");
    expect(workSentence([call("WebFetch", { url: "https://example.com" })])).toBe("Fetched 1 page");
    expect(workSentence([call("WebSearch", { query: "x" })])).toBe("Searched the web");
    expect(workSentence([call("todo_write", { todos: [] })])).toBe("Used 1 tool");
    expect(workSentence([item("tool_call")])).toBe("Used 1 tool");
  });

  it("tells the web, the in-app browser and other servers' tools apart", () => {
    expect(workSentence([item("web_search", { tool: { name: "s", input: { query: "q" } } })])).toBe(
      "Searched the web",
    );
    expect(workSentence([item("web_search", { tool: { name: "f", input: { url: "u" } } })])).toBe(
      "Fetched 1 page",
    );
    expect(
      workSentence([
        call("mcp__poseidon__browser_open", { url: "http://localhost" }, "mcp_tool_call"),
        call("mcp__poseidon__browser_click", { selector: "a" }, "mcp_tool_call"),
      ]),
    ).toBe("Used the browser");
    expect(workSentence([call("mcp__docs__lookup", {}, "mcp_tool_call")])).toBe("Called 1 tool");
  });

  it("spells out three clauses and folds the rest into 'and N more'", () => {
    const items = [
      run(),
      file("a.ts"),
      call("Read", { file_path: "b.ts" }),
      call("grep", { pattern: "x" }),
      call("grep", { pattern: "y" }),
      item("skill"),
    ];
    expect(workSentence(items)).toBe("Ran 1 command, edited 1 file, read 1 file and 3 more");
    expect(workSentence(items, 5)).toBe(
      "Ran 1 command, edited 1 file, read 1 file, searched 2 times, used 1 skill",
    );
  });

  it("has nothing to say about reasoning or narration alone", () => {
    expect(workSentence([item("reasoning"), item("assistant_message")])).toBeUndefined();
    expect(workSentence([])).toBeUndefined();
  });
});

describe("failures", () => {
  it("counts the failed items and notes them after the label", () => {
    const items = [run("failed"), run(), file("a.ts"), item("reasoning", { status: "failed" })];
    expect(countFailed(items)).toBe(2);
    expect(withFailures(workSentence(items)!, countFailed(items))).toBe(
      "Ran 2 commands, edited 1 file · 2 failed",
    );
    expect(withFailures("Ran 1 command", 0)).toBe("Ran 1 command");
  });
});

describe("workGroupLabel", () => {
  it("is the sentence when the group did anything", () => {
    expect(workGroupLabel([item("reasoning"), run(), run()], 4_000)).toBe("Ran 2 commands");
  });

  it("reads a reasoning-only group as a thought, timed when it can be", () => {
    expect(workGroupLabel([item("reasoning")], 2_000)).toBe("Thought for 2s");
    expect(workGroupLabel([item("reasoning")], 0)).toBe("Thought");
    expect(workGroupLabel([item("reasoning")], undefined)).toBe("Thought");
  });
});

describe("turnFoldLabel", () => {
  it("leads with how long the turn worked, then what it did", () => {
    expect(turnFoldLabel(123_000, "Ran 3 commands")).toBe("Worked for 2m 3s · Ran 3 commands");
    expect(turnFoldLabel(4_000, undefined)).toBe("Worked for 4s");
    expect(turnFoldLabel(undefined, "Ran 1 command")).toBe("Worked · Ran 1 command");
    expect(turnFoldLabel(0, undefined)).toBe("Worked");
  });
});
