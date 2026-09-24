import { describe, expect, it } from "vitest";

import {
  adjacentDockTab,
  dockArrivalTarget,
  dockTabTarget,
  dockToggleTarget,
  isDockPane,
  isDockTab,
  isProjectDockPane,
  noteDockShown,
  projectDockTabs,
  rememberDockMove,
} from "./dock-toggle";

describe("isDockPane", () => {
  it("takes the tabs and the launcher", () => {
    expect(isDockPane("changes")).toBe(true);
    expect(isDockPane("home")).toBe(true);
  });

  it("leaves the launcher out of the tabs", () => {
    expect(isDockTab("home")).toBe(false);
    expect(isDockTab("files")).toBe(true);
  });

  it("reads anything else as a closed dock", () => {
    expect(isDockPane("terminal")).toBe(false);
    expect(isDockPane(undefined)).toBe(false);
    expect(isDockPane(3)).toBe(false);
  });
});

describe("dockToggleTarget", () => {
  it("closes an open dock whatever it shows", () => {
    expect(dockToggleTarget("files", "browser")).toBeNull();
    expect(dockToggleTarget("changes", undefined)).toBeNull();
    expect(dockToggleTarget("home", "files")).toBeNull();
  });

  it("reopens a closed dock on the last tab used, else the launcher", () => {
    expect(dockToggleTarget(undefined, "files")).toBe("files");
    expect(dockToggleTarget(undefined, undefined)).toBe("home");
  });
});

describe("dockTabTarget", () => {
  it("opens the tab from a closed dock, the launcher or another tab", () => {
    expect(dockTabTarget(undefined, "files")).toBe("files");
    expect(dockTabTarget("home", "changes")).toBe("changes");
    expect(dockTabTarget("changes", "files")).toBe("files");
  });

  it("closes the dock when it already shows that tab", () => {
    expect(dockTabTarget("browser", "browser")).toBeNull();
  });
});

describe("dock memory", () => {
  it("starts with nothing to reopen", () => {
    expect(dockArrivalTarget(undefined)).toBeUndefined();
  });

  it("reopens what the user left the dock on", () => {
    expect(dockArrivalTarget(rememberDockMove(undefined, "browser"))).toBe("browser");
    expect(dockArrivalTarget(rememberDockMove(undefined, "home"))).toBe("home");
  });

  it("forgets the dock on close but keeps the last tab for the toggle", () => {
    const closed = rememberDockMove(rememberDockMove(undefined, "files"), null);
    expect(dockArrivalTarget(closed)).toBeUndefined();
    expect(dockToggleTarget(undefined, closed.lastTab)).toBe("files");
  });

  it("does not let the launcher replace the last tab", () => {
    const back = rememberDockMove(rememberDockMove(undefined, "browser"), "home");
    expect(back).toEqual({ shown: "home", lastTab: "browser" });
  });

  it("notes a tab someone else opened without reopening it on arrival", () => {
    const noted = noteDockShown(undefined, "changes");
    expect(noted?.lastTab).toBe("changes");
    expect(dockArrivalTarget(noted)).toBeUndefined();
  });

  it("returns the same memory when nothing new was shown", () => {
    const memory = rememberDockMove(undefined, "files");
    expect(noteDockShown(memory, "files")).toBe(memory);
    expect(noteDockShown(memory, "home")).toBe(memory);
    expect(noteDockShown(memory, undefined)).toBe(memory);
  });
});

describe("adjacentDockTab", () => {
  it("steps along the strip and wraps", () => {
    expect(adjacentDockTab("changes", 1)).toBe("browser");
    expect(adjacentDockTab("files", 1)).toBe("changes");
    expect(adjacentDockTab("changes", -1)).toBe("files");
  });

  it("steps from the launcher's tab stop, the first tab", () => {
    expect(adjacentDockTab("home", 1)).toBe("browser");
    expect(adjacentDockTab("home", -1)).toBe("files");
    expect(adjacentDockTab("home", 1)).toBe(adjacentDockTab("changes", 1));
  });
});

describe("a project's dock", () => {
  it("offers Changes and Files, and no Browser", () => {
    expect(projectDockTabs).toEqual(["changes", "files"]);
  });

  it("steps along its own strip, from the launcher too", () => {
    expect(adjacentDockTab("changes", 1, projectDockTabs)).toBe("files");
    expect(adjacentDockTab("files", 1, projectDockTabs)).toBe("changes");
    expect(adjacentDockTab("changes", -1, projectDockTabs)).toBe("files");
    expect(adjacentDockTab("home", 1, projectDockTabs)).toBe("files");
  });

  it("steps from its first tab when asked from a tab it does not hold", () => {
    expect(adjacentDockTab("browser", 1, projectDockTabs)).toBe("files");
  });

  it("reads a Browser `?pane=` as a closed dock", () => {
    expect(isProjectDockPane("changes")).toBe(true);
    expect(isProjectDockPane("files")).toBe(true);
    expect(isProjectDockPane("home")).toBe(true);
    expect(isProjectDockPane("browser")).toBe(false);
    expect(isProjectDockPane(undefined)).toBe(false);
  });
});
