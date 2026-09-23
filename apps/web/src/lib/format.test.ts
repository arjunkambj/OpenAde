import { describe, expect, it } from "vitest";

import { formatElapsed, turnSummaryLabel, turnSummaryLead, workGroupLabel } from "./format";

describe("workGroupLabel", () => {
  it("reports the tool count and the duration", () => {
    expect(workGroupLabel({ toolCount: 3, durationMs: 4_250 })).toBe("3 tools · 4.3s");
    expect(workGroupLabel({ toolCount: 1, durationMs: 65_000 })).toBe("1 tool · 1m 5s");
  });

  it("calls a fold with no tools a thought", () => {
    expect(workGroupLabel({ toolCount: 0, durationMs: 2_000 })).toBe("Thought for 2s");
  });

  it("drops the duration when the ids carry no timing", () => {
    expect(workGroupLabel({ toolCount: 6, durationMs: undefined })).toBe("6 tools");
    expect(workGroupLabel({ toolCount: 0, durationMs: undefined })).toBe("Thought");
  });

  it("treats a zero duration as no timing rather than as 0ms", () => {
    expect(workGroupLabel({ toolCount: 6, durationMs: 0 })).toBe("6 tools");
    expect(workGroupLabel({ toolCount: 0, durationMs: 0 })).toBe("Thought");
  });

  it("keeps sub-second runs honest", () => {
    expect(workGroupLabel({ toolCount: 2, durationMs: 40 })).toBe("2 tools · 40ms");
  });

  it("leaves 'Worked for' to the turn summary", () => {
    expect(workGroupLabel({ toolCount: 3, durationMs: 4_000 })).not.toContain("Worked");
  });
});

describe("turnSummaryLabel", () => {
  const files = (count: number) => Array.from({ length: count }, (_, index) => index);

  it("reports time, files and line counts with a real minus sign", () => {
    expect(turnSummaryLabel({ durationMs: 12_000, files: files(3), added: 20, removed: 4 })).toBe(
      "Worked for 12s · 3 files +20 −4",
    );
    expect(turnSummaryLabel({ durationMs: 12_000, files: files(1), added: 0, removed: 4 })).toBe(
      "Worked for 12s · 1 file −4",
    );
  });

  it("says only how long it worked when no file changed", () => {
    expect(turnSummaryLabel({ durationMs: 12_000, files: [], added: 0, removed: 0 })).toBe(
      "Worked for 12s",
    );
  });

  it("drops an unknown or zero duration", () => {
    expect(turnSummaryLabel({ durationMs: undefined, files: files(2), added: 1, removed: 0 })).toBe(
      "Worked · 2 files +1",
    );
    expect(turnSummaryLabel({ durationMs: 0, files: [], added: 0, removed: 0 })).toBe("Worked");
  });

  it("keeps the counts out of the lead the row colours itself", () => {
    expect(turnSummaryLead({ durationMs: 12_000, files: files(3) })).toBe(
      "Worked for 12s · 3 files",
    );
  });
});

describe("formatElapsed", () => {
  it("counts whole seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("pads the seconds once minutes show", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59m 59s");
  });

  it("drops to hours and padded minutes past an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 00m");
    expect(formatElapsed(3_600_000 + 2 * 60_000 + 30_000)).toBe("1h 02m");
  });

  it("reads a negative span from clock skew as zero", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});
