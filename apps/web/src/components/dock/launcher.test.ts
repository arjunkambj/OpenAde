import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "vitest";

import {
  browserStatus,
  changesStatus,
  filesStatus,
  folderName,
  launcherFocusMove,
  launcherLetterPick,
  uncommittedCount,
  type GitRead,
} from "./launcher";

const status = (over: Partial<GitStatus> = {}): GitRead<GitStatus> => ({
  _tag: "ok",
  value: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [], ...over },
});

const file = (path: string) => ({ path, status: "modified" as const, staged: false });

const diff = (counts: ReadonlyArray<[number, number]>): GitRead<GitDiff> => ({
  _tag: "ok",
  value: {
    from: "HEAD",
    to: null,
    files: counts.map(([additions, deletions], index) => ({
      path: `f${index}`,
      kind: "edit" as const,
      diff: "",
      additions,
      deletions,
    })),
  },
});

describe("changesStatus", () => {
  it("counts uncommitted files with the diff's totals", () => {
    expect(
      changesStatus(
        true,
        status({ files: [file("a"), file("b")] }),
        diff([
          [3, 1],
          [2, 0],
        ]),
      ),
    ).toEqual({ text: "2 changed files", disabled: false, additions: 5, deletions: 1 });
  });

  it("shows the count alone while the diff is still loading", () => {
    expect(changesStatus(true, status({ files: [file("a")] }), null)).toEqual({
      text: "1 changed file",
      disabled: false,
    });
  });

  it("says a clean tree has no changes", () => {
    expect(changesStatus(true, status(), diff([]))).toEqual({
      text: "No changes",
      disabled: false,
    });
  });

  it("disables the row for a workspace git does not track", () => {
    expect(changesStatus(true, status({ branch: null }), null)).toEqual({
      text: "Not a git repository",
      disabled: true,
    });
    expect(changesStatus(true, status({ isRepository: false }), null).disabled).toBe(true);
  });

  it("tells loading, offline and a failed read apart", () => {
    expect(changesStatus(true, null, null).text).toBe("Checking for changes…");
    expect(changesStatus(false, null, null).text).toBe("Not connected");
    expect(changesStatus(true, { _tag: "broken" }, null).text).toBe("Could not read git status");
    expect(changesStatus(true, { _tag: "error", message: "boom" }, null).disabled).toBe(false);
  });
});

describe("uncommittedCount", () => {
  it("is the file count for a repository", () => {
    expect(uncommittedCount(status({ files: [file("a")] }))).toBe(1);
    expect(uncommittedCount(status())).toBe(0);
  });

  it("is null with nothing to count", () => {
    expect(uncommittedCount(null)).toBeNull();
    expect(uncommittedCount(status({ branch: null }))).toBeNull();
    expect(uncommittedCount({ _tag: "broken" })).toBeNull();
  });
});

describe("browserStatus", () => {
  it("counts the thread's tabs", () => {
    expect(browserStatus(0, false).text).toBe("No tabs open");
    expect(browserStatus(1, false).text).toBe("1 tab open");
    expect(browserStatus(3, false).text).toBe("3 tabs open");
  });

  it("says when the agent is using the browser", () => {
    expect(browserStatus(2, true).text).toBe("Agent is using the browser");
  });
});

describe("folderName", () => {
  it("takes the last segment of either kind of path", () => {
    expect(folderName("/Users/me/code/app")).toBe("app");
    expect(folderName("/Users/me/code/app/")).toBe("app");
    expect(folderName("C:\\work\\app")).toBe("app");
  });

  it("names the root with no directory to show", () => {
    expect(filesStatus(null).text).toBe("This project's files");
    expect(filesStatus("/srv/site").text).toBe("site");
  });
});

describe("launcherFocusMove", () => {
  const all = [true, true, true];

  it("steps and wraps", () => {
    expect(launcherFocusMove("ArrowDown", all, 0)).toBe(1);
    expect(launcherFocusMove("ArrowDown", all, 2)).toBe(0);
    expect(launcherFocusMove("ArrowUp", all, 0)).toBe(2);
    expect(launcherFocusMove("Home", all, 2)).toBe(0);
    expect(launcherFocusMove("End", all, 0)).toBe(2);
  });

  it("skips disabled rows", () => {
    expect(launcherFocusMove("ArrowDown", [false, true, true], 2)).toBe(1);
    expect(launcherFocusMove("ArrowUp", [false, true, true], 1)).toBe(2);
    expect(launcherFocusMove("Home", [false, true, true], 2)).toBe(1);
  });

  it("ignores other keys and a launcher with nothing enabled", () => {
    expect(launcherFocusMove("Enter", all, 0)).toBeNull();
    expect(launcherFocusMove("ArrowDown", [false, false], 0)).toBeNull();
  });
});

describe("launcherLetterPick", () => {
  const rows = [
    { tab: "changes" as const, label: "Changes", disabled: false },
    { tab: "browser" as const, label: "Browser", disabled: false },
    { tab: "files" as const, label: "Files", disabled: false },
  ];

  it("picks a row by its first letter, either case", () => {
    expect(launcherLetterPick("c", rows)).toBe("changes");
    expect(launcherLetterPick("B", rows)).toBe("browser");
    expect(launcherLetterPick("f", rows)).toBe("files");
  });

  it("does not pick a disabled row or answer other keys", () => {
    expect(launcherLetterPick("c", [{ ...rows[0]!, disabled: true }])).toBeNull();
    expect(launcherLetterPick("x", rows)).toBeNull();
    expect(launcherLetterPick("Enter", rows)).toBeNull();
  });
});
