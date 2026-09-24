import { describe, expect, it } from "vitest";

import { launcherFocusMove, launcherLetterPick } from "./launcher";

describe("launcherFocusMove", () => {
  it("steps and wraps", () => {
    expect(launcherFocusMove("ArrowDown", 3, 0)).toBe(1);
    expect(launcherFocusMove("ArrowDown", 3, 2)).toBe(0);
    expect(launcherFocusMove("ArrowUp", 3, 0)).toBe(2);
    expect(launcherFocusMove("Home", 3, 2)).toBe(0);
    expect(launcherFocusMove("End", 3, 0)).toBe(2);
  });

  it("ignores other keys and an empty launcher", () => {
    expect(launcherFocusMove("Enter", 3, 0)).toBeNull();
    expect(launcherFocusMove("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("launcherLetterPick", () => {
  const rows = [
    { tab: "changes" as const, label: "Changes" },
    { tab: "browser" as const, label: "Browser" },
    { tab: "files" as const, label: "Files" },
  ];

  it("picks a row by its first letter, either case", () => {
    expect(launcherLetterPick("c", rows)).toBe("changes");
    expect(launcherLetterPick("B", rows)).toBe("browser");
    expect(launcherLetterPick("f", rows)).toBe("files");
  });

  it("does not answer other keys", () => {
    expect(launcherLetterPick("x", rows)).toBeNull();
    expect(launcherLetterPick("Enter", rows)).toBeNull();
  });
});
