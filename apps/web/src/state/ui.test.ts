import { describe, expect, it } from "vitest";

import { parseDockTabs } from "./ui";

describe("parseDockTabs", () => {
  it("reads a thread-to-tab map back", () => {
    expect(parseDockTabs('{"0199c0de-0002-7000-8000-000000000001":"browser"}')).toEqual({
      "0199c0de-0002-7000-8000-000000000001": "browser",
    });
  });

  it("is empty when nothing was ever stored", () => {
    expect(parseDockTabs(null)).toEqual({});
    expect(parseDockTabs(undefined)).toEqual({});
  });

  it("survives storage written by something else", () => {
    expect(parseDockTabs("not json")).toEqual({});
    expect(parseDockTabs('["browser"]')).toEqual({});
    expect(parseDockTabs("null")).toEqual({});
  });

  it("drops entries that are not tab names", () => {
    expect(parseDockTabs('{"a":"changes","b":7,"c":null}')).toEqual({ a: "changes" });
  });
});
