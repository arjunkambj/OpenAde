import { describe, expect, it } from "vitest";

import { paletteFilter, paletteQuery } from "./palette-query";

describe("paletteQuery", () => {
  it("reads a bare > as commands only with nothing to match", () => {
    expect(paletteQuery(">")).toEqual({ commandsOnly: true, query: "" });
  });

  it("matches the text after the >", () => {
    expect(paletteQuery("> set")).toEqual({ commandsOnly: true, query: "set" });
  });

  it("ignores the whitespace before the >", () => {
    expect(paletteQuery("  >x")).toEqual({ commandsOnly: true, query: "x" });
  });

  it("keeps plain text as a search over everything", () => {
    expect(paletteQuery("fix login")).toEqual({ commandsOnly: false, query: "fix login" });
  });

  it("reads an empty input as no query", () => {
    expect(paletteQuery("")).toEqual({ commandsOnly: false, query: "" });
  });

  it("does not treat a > later in the text as command mode", () => {
    expect(paletteQuery("a > b")).toEqual({ commandsOnly: false, query: "a > b" });
  });
});

describe("paletteFilter", () => {
  it("keeps every entry when there is nothing to match", () => {
    expect(paletteFilter("Settings General", ">")).toBe(1);
    expect(paletteFilter("Settings General", " >  ")).toBe(1);
  });

  it("scores against the text after the > rather than the raw input", () => {
    expect(paletteFilter("Settings General", "> gen")).toBeGreaterThan(0);
    expect(paletteFilter("Toggle sidebar", "> gen")).toBe(0);
  });

  it("scores plain text as it is", () => {
    expect(paletteFilter("Fix login flow", "login")).toBeGreaterThan(0);
    expect(paletteFilter("Fix login flow", "zzz")).toBe(0);
  });

  it("matches keywords too", () => {
    expect(paletteFilter("General", "prefs", ["prefs"])).toBeGreaterThan(0);
  });
});
