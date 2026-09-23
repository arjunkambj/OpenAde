import { describe, expect, it } from "vitest";

import { archivedGroups } from "./archived-groups";

const thread = (threadId: string, projectId: string, status: "idle" | "archived") => ({
  threadId,
  projectId,
  status,
});

const projects = [
  { projectId: "p1", name: "First" },
  { projectId: "p2", name: "Second" },
];

const shape = (groups: ReturnType<typeof archivedGroups<ReturnType<typeof thread>>>) =>
  groups.map((group) => [group.name, group.threads.map((t) => t.threadId)]);

describe("archivedGroups", () => {
  it("keeps only archived threads", () => {
    const threads = [thread("a", "p1", "idle"), thread("b", "p1", "archived")];
    expect(shape(archivedGroups(threads, projects))).toEqual([["First", ["b"]]]);
  });

  it("groups by project in project order, keeping the list's order within a group", () => {
    const threads = [
      thread("a", "p2", "archived"),
      thread("b", "p1", "archived"),
      thread("c", "p2", "archived"),
      thread("d", "p1", "archived"),
    ];
    expect(shape(archivedGroups(threads, projects))).toEqual([
      ["First", ["b", "d"]],
      ["Second", ["a", "c"]],
    ]);
  });

  it("puts threads of an unknown project in a last Other threads group", () => {
    const threads = [
      thread("a", "gone", "archived"),
      thread("b", "p2", "archived"),
      thread("c", "also-gone", "archived"),
      thread("d", "gone", "archived"),
    ];
    const groups = archivedGroups(threads, projects);
    expect(shape(groups)).toEqual([
      ["Second", ["b"]],
      ["Other threads", ["a", "c", "d"]],
    ]);
    expect(groups.at(-1)?.projectId).toBeNull();
  });

  it("leaves out projects with nothing archived", () => {
    const threads = [thread("a", "p1", "idle"), thread("b", "p2", "idle")];
    expect(archivedGroups(threads, projects)).toEqual([]);
  });
});
