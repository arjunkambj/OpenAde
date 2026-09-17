import { describe, expect, it } from "vitest";

import { workGroupLabel } from "./format";

describe("workGroupLabel", () => {
  it("reports the duration and the tool count", () => {
    expect(workGroupLabel({ toolCount: 3, durationMs: 4_250 })).toBe("Worked for 4.3s · 3 tools");
    expect(workGroupLabel({ toolCount: 1, durationMs: 65_000 })).toBe("Worked for 1m 5s · 1 tool");
  });

  it("calls a fold with no tools a thought", () => {
    expect(workGroupLabel({ toolCount: 0, durationMs: 2_000 })).toBe("Thought for 2s");
  });

  it("drops the duration when the ids carry no timing", () => {
    expect(workGroupLabel({ toolCount: 6, durationMs: undefined })).toBe("Worked · 6 tools");
    expect(workGroupLabel({ toolCount: 0, durationMs: undefined })).toBe("Thought");
  });

  it("treats a zero duration as no timing rather than as 0ms", () => {
    expect(workGroupLabel({ toolCount: 6, durationMs: 0 })).toBe("Worked · 6 tools");
    expect(workGroupLabel({ toolCount: 0, durationMs: 0 })).toBe("Thought");
  });

  it("keeps sub-second runs honest", () => {
    expect(workGroupLabel({ toolCount: 2, durationMs: 40 })).toBe("Worked for 40ms · 2 tools");
  });
});
