import { describe, expect, it } from "vitest";

import { errorSummary } from "./error-screen";

describe("errorSummary", () => {
  it("takes the first line of an Error", () => {
    expect(errorSummary(new Error("thread detail failed to decode\n  at foo"))).toBe(
      "thread detail failed to decode",
    );
  });

  it("handles the things React can throw that are not Errors", () => {
    expect(errorSummary("plain string")).toBe("plain string");
    expect(errorSummary({ code: 7 })).toBe("[object Object]");
  });

  it("never renders an empty line", () => {
    expect(errorSummary(new Error(""))).toBe("Something went wrong.");
    expect(errorSummary(null)).toBe("Something went wrong.");
    expect(errorSummary(undefined)).toBe("Something went wrong.");
    expect(errorSummary("   \n  ")).toBe("Something went wrong.");
  });
});
