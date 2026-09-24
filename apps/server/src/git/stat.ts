/**
 * The existence check behind `files.stat`: which of a batch of paths are real
 * files or directories inside a workspace root. It holds every path to the
 * containment `files.read` does, lexically first and then canonically, so a
 * `..`, an absolute path elsewhere or a symlink out of the root is never
 * reported — a caller learns that a path exists only when it could read it.
 *
 * A path that fails any step is left out rather than failing the batch: the
 * timeline asks about every path-shaped string in a message, and most of the
 * strings that merely look like paths are not ones.
 */
import { realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import type { FileStat } from "@OpenAde/contracts/rpc";

/** How many paths are resolved at once; a batch is at most a hundred. */
const CONCURRENCY = 16;

/** `path` under `base`, strictly inside it, or null. */
const within = (base: string, path: string): string | null => {
  const relative = nodePath.relative(base, path);
  const escapes = relative === ".." || relative.startsWith(`..${nodePath.sep}`);
  return relative.length > 0 && !escapes && !nodePath.isAbsolute(relative) ? relative : null;
};

/**
 * One path, or null. A relative path resolves against `root`; an absolute one
 * counts when it lies under `root` as written or under its canonical form,
 * because a harness may report either (`/var/…` and `/private/var/…` on
 * macOS). The target is then resolved through every symlink and has to land
 * strictly inside the canonical root too.
 */
const statOne = async (root: string, realRoot: string, path: string): Promise<FileStat | null> => {
  const absolute = nodePath.resolve(root, path);
  const relative = within(nodePath.resolve(root), absolute) ?? within(realRoot, absolute);
  if (relative === null) return null;
  try {
    const target = await realpath(absolute);
    if (within(realRoot, target) === null) return null;
    const info = await stat(target);
    return {
      path,
      relativePath: relative.split(nodePath.sep).join("/"),
      absolutePath: nodePath.join(root, relative),
      isDirectory: info.isDirectory(),
    };
  } catch {
    return null;
  }
};

/**
 * The paths of `paths` that exist inside `root`, each once, in the order they
 * were first asked. An unresolvable root answers nothing.
 */
export const statWorkspacePaths = async (
  root: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<FileStat>> => {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return [];
  }
  const unique = [...new Set(paths)];
  const found: Array<FileStat | null> = [];
  for (let start = 0; start < unique.length; start += CONCURRENCY) {
    const slice = unique.slice(start, start + CONCURRENCY);
    found.push(...(await Promise.all(slice.map((path) => statOne(root, realRoot, path)))));
  }
  return found.filter((entry): entry is FileStat => entry !== null);
};
