/**
 * `formatDurationMs(4_250)` → `"4.3s"`. A reasoning group's "Thought for", the
 * turn summary and the final answer's footer use this: sub-second precision
 * matters, minute-plus durations read as `1m 5s`.
 */
export const formatDurationMs = (ms: number): string => {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms - minutes * 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

/** A duration worth printing: zero reads as a broken clock, so it counts as none. */
const measured = (ms: number | undefined): string | undefined =>
  ms !== undefined && ms > 0 ? formatDurationMs(ms) : undefined;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The turn summary up to its diff counts: "Worked for 12s · 3 files", "Worked
 * for 12s" when no file changed, "Worked" when the ids carry no timing. The
 * row renders the counts itself so it can colour them.
 */
export const turnSummaryLead = (summary: {
  readonly durationMs: number | undefined;
  readonly files: ReadonlyArray<unknown>;
}): string => {
  const duration = measured(summary.durationMs);
  const lead = duration === undefined ? "Worked" : `Worked for ${duration}`;
  return summary.files.length === 0
    ? lead
    : `${lead} · ${plural(summary.files.length, "file", "files")}`;
};

/** "+20 −4", with a real minus sign; a zero side is left out. */
const diffCountLabel = (counts: { readonly added: number; readonly removed: number }): string =>
  [counts.added > 0 ? `+${counts.added}` : "", counts.removed > 0 ? `−${counts.removed}` : ""]
    .filter((part) => part !== "")
    .join(" ");

/** The whole turn summary as one string: "Worked for 12s · 3 files +20 −4". */
export const turnSummaryLabel = (summary: {
  readonly durationMs: number | undefined;
  readonly files: ReadonlyArray<unknown>;
  readonly added: number;
  readonly removed: number;
}): string => {
  const counts = diffCountLabel(summary);
  const lead = turnSummaryLead(summary);
  return counts === "" ? lead : `${lead} ${counts}`;
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");

/**
 * The live clock on a running turn: "0s", "12s", "1m 05s", "1h 02m". Whole
 * seconds only and zero-padded lower units, so the label keeps its width and
 * does not jitter as it ticks. A negative span (clock skew) reads as "0s".
 */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${pad2(minutes)}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad2(seconds)}s`;
  }
  return `${seconds}s`;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long ago `iso` was, for a sidebar row: "now" under a minute, then "5m",
 * "3h", "2d", "4w", and past a year the month it happened, "Mar 2025". Each
 * unit rounds down, so a label never claims more time than has passed. A time
 * ahead of `nowMs` (clock skew) reads as "now"; an unparseable one reads as
 * nothing.
 */
export const relativeTime = (nowMs: number, iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const ago = nowMs - then;
  if (ago < MINUTE) {
    return "now";
  }
  if (ago < HOUR) {
    return `${Math.floor(ago / MINUTE)}m`;
  }
  if (ago < DAY) {
    return `${Math.floor(ago / HOUR)}h`;
  }
  if (ago < WEEK) {
    return `${Math.floor(ago / DAY)}d`;
  }
  if (ago < YEAR) {
    return `${Math.floor(ago / WEEK)}w`;
  }
  const date = new Date(then);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A message's time of day in local time, 24-hour and zero-padded: "14:05",
 * "09:30". Built by hand rather than through `Intl` so it reads the same in
 * every locale and in tests.
 */
export const formatClock = (ms: number): string => {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/** The same moment in full, for the clock's tooltip: "Thursday, 24 Sep 2026, 14:05". */
export const formatFullDate = (ms: number): string => {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${formatClock(ms)}`;
};
