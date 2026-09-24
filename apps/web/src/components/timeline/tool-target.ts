/**
 * The short target a tool row shows after the tool's name: the file it read,
 * the command it ran, the pattern it searched for. Tool inputs are free-form
 * JSON, so this probes the keys harnesses commonly use, in order, and takes the
 * first non-empty string — first line only, cut to fit one row.
 *
 * The first three keys name a file. `toolPathTarget` reads just those, whole,
 * so the row can offer the file as a chip once the workspace confirms it.
 */

const PATH_KEYS = ["file_path", "path", "filePath"];
const TARGET_KEYS = [...PATH_KEYS, "command", "pattern", "url", "query"];

const MAX_TARGET = 60;

export const toolTarget = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const line = value.trim().split("\n", 1)[0].trim();
    if (line === "") {
      continue;
    }
    return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET)}…` : line;
  }
  return undefined;
};

/** The file a tool's input names, as written, or undefined when it names none. */
export const toolPathTarget = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "" && !value.includes("\n")) {
      return value.trim();
    }
  }
  return undefined;
};
