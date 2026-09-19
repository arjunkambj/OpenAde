import { describe, expect, it } from "vitest";

import { quitsWhenAllWindowsClosed } from "./lifecycle";

describe("quitsWhenAllWindowsClosed", () => {
  it("keeps macOS resident so the activate handler can reopen a window", () => {
    expect(quitsWhenAllWindowsClosed("darwin")).toBe(false);
  });

  it("quits everywhere else", () => {
    expect(quitsWhenAllWindowsClosed("win32")).toBe(true);
    expect(quitsWhenAllWindowsClosed("linux")).toBe(true);
  });
});
