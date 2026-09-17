/**
 * `formatDurationMs(4_250)` → `"4s"`. The "Worked for Ns" labels use this:
 * sub-second precision matters, minute-plus durations read as `1m 5s`.
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

/**
 * The folded work-group label: "Worked for 4s · 3 tools", "Worked · 1 tool"
 * when the ids carry no timing, "Thought for 2s" for a reasoning-only fold.
 */
export const workGroupLabel = (group: {
  readonly toolCount: number;
  readonly durationMs: number | undefined;
}): string => {
  const duration =
    group.durationMs !== undefined ? ` for ${formatDurationMs(group.durationMs)}` : "";
  if (group.toolCount === 0) {
    return `Thought${duration}`;
  }
  return `Worked${duration} · ${group.toolCount} ${group.toolCount === 1 ? "tool" : "tools"}`;
};
