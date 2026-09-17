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
