/**
 * The hunk header the unified-diff parser insists on. A patch without one
 * renders as nothing at all, so callers check first and fall back to the raw
 * text rather than showing an empty box where a diff should be.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

export const hasHunkHeader = (diff: string): boolean => HUNK_HEADER.test(diff);

/**
 * Counts added/removed lines in a unified diff body. `+++`/`---` file headers
 * are excluded; anything else leading with `+`/`-` counts.
 */
export const diffStats = (diff: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
};
