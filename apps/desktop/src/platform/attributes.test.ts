import { describe, expect, it } from "vitest";

import { desktopAttributes } from "./attributes";

describe("desktopAttributes", () => {
  it("flags every desktop shell", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(desktopAttributes(platform)).toContain("data-desktop");
    }
  });

  it("adds the mac-only attribute on macOS alone", () => {
    expect(desktopAttributes("darwin")).toEqual(["data-desktop", "data-desktop-mac"]);
    expect(desktopAttributes("win32")).toEqual(["data-desktop"]);
    expect(desktopAttributes("linux")).toEqual(["data-desktop"]);
  });
});
