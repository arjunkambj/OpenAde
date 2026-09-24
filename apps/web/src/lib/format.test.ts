import { describe, expect, it } from "vitest";

import {
  formatClock,
  formatElapsed,
  formatFullDate,
  relativeTime,
  turnSummaryLead,
} from "./format";

describe("turnSummaryLead", () => {
  const files = (count: number) => Array.from({ length: count }, (_, index) => index);

  it("counts the files the turn changed", () => {
    expect(turnSummaryLead({ files: files(3) })).toBe("Changed 3 files");
    expect(turnSummaryLead({ files: files(1) })).toBe("Changed 1 file");
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

describe("relativeTime", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("reads anything under a minute as now", () => {
    expect(relativeTime(now, ago(0))).toBe("now");
    expect(relativeTime(now, ago(59_999))).toBe("now");
  });

  it("counts minutes, then hours, rounding down", () => {
    expect(relativeTime(now, ago(MIN))).toBe("1m");
    expect(relativeTime(now, ago(5 * MIN + 59_000))).toBe("5m");
    expect(relativeTime(now, ago(HOUR - 1))).toBe("59m");
    expect(relativeTime(now, ago(HOUR))).toBe("1h");
    expect(relativeTime(now, ago(3 * HOUR + 59 * MIN))).toBe("3h");
    expect(relativeTime(now, ago(DAY - 1))).toBe("23h");
  });

  it("counts days under a week, then weeks under a year", () => {
    expect(relativeTime(now, ago(DAY))).toBe("1d");
    expect(relativeTime(now, ago(7 * DAY - 1))).toBe("6d");
    expect(relativeTime(now, ago(7 * DAY))).toBe("1w");
    expect(relativeTime(now, ago(30 * DAY))).toBe("4w");
    expect(relativeTime(now, ago(365 * DAY - 1))).toBe("52w");
  });

  it("falls back to the month past a year", () => {
    // Mid-month, so the local time zone cannot move it across a boundary.
    expect(relativeTime(now, "2025-03-14T12:00:00.000Z")).toBe("Mar 2025");
    expect(relativeTime(now, "2019-11-14T12:00:00.000Z")).toBe("Nov 2019");
  });

  it("reads a time in the future as now and garbage as nothing", () => {
    expect(relativeTime(now, ago(-5 * MIN))).toBe("now");
    expect(relativeTime(now, "not a date")).toBe("");
  });
});

describe("formatClock and formatFullDate", () => {
  // Built from local fields, so the assertions hold in any time zone.
  const at = (hours: number, minutes: number) =>
    new Date(2026, 8, 24, hours, minutes, 42).getTime();

  it("reads the local time of day, 24-hour and zero-padded", () => {
    expect(formatClock(at(14, 5))).toBe("14:05");
    expect(formatClock(at(9, 30))).toBe("09:30");
    expect(formatClock(at(0, 0))).toBe("00:00");
    expect(formatClock(at(23, 59))).toBe("23:59");
  });

  it("spells the day out for the tooltip", () => {
    expect(formatFullDate(at(14, 5))).toBe("Thursday, 24 Sep 2026, 14:05");
    expect(formatFullDate(new Date(2025, 0, 5, 8, 7).getTime())).toBe("Sunday, 5 Jan 2025, 08:07");
  });
});
