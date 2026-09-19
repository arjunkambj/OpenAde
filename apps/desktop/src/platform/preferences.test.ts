import { describe, expect, it } from "vitest";

import { preferencesPath, readDesktopPreferences } from "./preferences";

const reading = (contents: string) => (): string => contents;

const missing = (): string => {
  throw new Error("ENOENT");
};

describe("preferencesPath", () => {
  it("sits in the OPENADE_HOME-resolved config dir", () => {
    expect(preferencesPath({ OPENADE_HOME: "/tmp/home-a" })).toBe("/tmp/home-a/desktop.json");
  });
});

describe("readDesktopPreferences", () => {
  it("defaults the browser pane off when there is no file", () => {
    expect(readDesktopPreferences("/nowhere/desktop.json", missing)).toEqual({
      browserPane: false,
    });
  });

  it("defaults the browser pane off on unusable contents", () => {
    for (const contents of ["", "{", "null", "[]", `"nope"`, `{"browserPane":"yes"}`, "{}"]) {
      expect(readDesktopPreferences("/x", reading(contents))).toEqual({ browserPane: false });
    }
  });

  it("reads the browser pane opt-in", () => {
    expect(readDesktopPreferences("/x", reading(`{"browserPane":true}`))).toEqual({
      browserPane: true,
    });
    expect(readDesktopPreferences("/x", reading(`{"browserPane":false}`))).toEqual({
      browserPane: false,
    });
  });

  it("ignores keys it does not own", () => {
    expect(readDesktopPreferences("/x", reading(`{"browserPane":true,"other":1}`))).toEqual({
      browserPane: true,
    });
  });
});
