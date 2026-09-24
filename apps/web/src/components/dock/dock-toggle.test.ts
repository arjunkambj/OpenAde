import { describe, expect, it } from "vitest";

import { dockTabTarget, dockToggleTarget } from "./dock-toggle";

describe("dockToggleTarget", () => {
  it("closes an open dock whatever tab it shows", () => {
    expect(dockToggleTarget("files", "browser")).toBeNull();
    expect(dockToggleTarget("changes", undefined)).toBeNull();
  });

  it("reopens a closed dock on the tab it was closed on, else changes", () => {
    expect(dockToggleTarget(undefined, "files")).toBe("files");
    expect(dockToggleTarget(undefined, undefined)).toBe("changes");
  });
});

describe("dockTabTarget", () => {
  it("opens the tab from a closed dock or another tab", () => {
    expect(dockTabTarget(undefined, "files")).toBe("files");
    expect(dockTabTarget("changes", "files")).toBe("files");
  });

  it("closes the dock when it already shows that tab", () => {
    expect(dockTabTarget("browser", "browser")).toBeNull();
  });
});
