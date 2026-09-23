/**
 * `formatDurationMs(4_250)` → `"4.3s"`. The work-group and turn-summary labels
 * use this: sub-second precision matters, minute-plus durations read as `1m 5s`.
 */
const formatDurationMs = (ms: number): string => {
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
 * The folded work-group label: "3 tools · 4s", "1 tool" when the ids carry no
 * timing, "Thought for 2s" for a reasoning-only fold. The turn's closing
 * summary owns "Worked for", so the group names what it holds instead.
 *
 * A zero duration is treated as no timing rather than as a measurement: it
 * means the group's items share a millisecond, and "0ms" reads as a broken
 * clock where leaving it out reads as a fact.
 */
export const workGroupLabel = (group: {
  readonly toolCount: number;
  readonly durationMs: number | undefined;
}): string => {
  const duration = measured(group.durationMs);
  if (group.toolCount === 0) {
    return duration === undefined ? "Thought" : `Thought for ${duration}`;
  }
  const tools = plural(group.toolCount, "tool", "tools");
  return duration === undefined ? tools : `${tools} · ${duration}`;
};

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
