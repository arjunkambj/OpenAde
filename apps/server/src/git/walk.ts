/**
 * The filesystem fallback behind `files.search` when the workspace is not a
 * git repository (or `git` cannot be run at all). `git ls-files` is the fast
 * path and gives .gitignore handling for free; this walker reproduces enough
 * of it — `.gitignore` files collected as the walk descends, `.git` always
 * skipped — that opening a plain folder as a project still answers the
 * composer's `@` search instead of failing the RPC.
 *
 * The supported pattern subset is the one real ignore files use: comments,
 * `!` negation, a trailing `/` for directory-only, a leading or interior `/`
 * for anchoring, a leading double-star segment for "at any depth", `?`, `*`
 * within one segment and `**` across segments.
 */
import { readdir, readFile } from "node:fs/promises";
import * as nodePath from "node:path";

/** Stop here however deep the tree goes — a walk is a user-facing keystroke. */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;

interface IgnoreRule {
  /** Matched against the path relative to the directory the rule came from. */
  readonly test: RegExp;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  /** Directory the rule was declared in, relative to the walk root. */
  readonly base: string;
}

/** One glob segment body → its regex source, `*`/`?` never crossing a `/`. */
const escapeSegment = (segment: string): string =>
  segment
    .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");

/**
 * A `.gitignore` line → a regex over the path relative to `base`. `**` is
 * expanded before the per-segment escaping so it alone may cross separators.
 */
const toRegExp = (pattern: string, anchored: boolean): RegExp => {
  const parts = pattern.split("**").map(escapeSegment);
  const body = parts.join("(?:.*)");
  // An unanchored pattern matches at any depth, the way git's does.
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}$`);
};

const parseIgnoreFile = (content: string, base: string): ReadonlyArray<IgnoreRule> => {
  const rules: Array<IgnoreRule> = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) pattern = pattern.slice(0, -1);
    // A leading `**/` means "at any depth", which is what the bare pattern
    // already does here — strip it so the interior `/` it carries does not
    // then pin `**/node_modules` to a subdirectory.
    const leadingDoubleStar = pattern.startsWith("**/");
    if (leadingDoubleStar) pattern = pattern.slice(3);
    // A leading `/`, or any interior one, pins the pattern to `base`.
    const anchored =
      !leadingDoubleStar && (pattern.startsWith("/") || pattern.slice(0, -1).includes("/"));
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern.length === 0) continue;
    rules.push({ test: toRegExp(pattern, anchored), negated, directoryOnly, base });
  }
  return rules;
};

/** Last matching rule wins, exactly as git resolves a negation. */
const isIgnored = (
  rules: ReadonlyArray<IgnoreRule>,
  path: string,
  isDirectory: boolean,
): boolean => {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const relative = rule.base === "" ? path : path.slice(rule.base.length + 1);
    if (rule.base !== "" && !path.startsWith(`${rule.base}/`)) continue;
    if (rule.test.test(relative)) ignored = !rule.negated;
  }
  return ignored;
};

const readIgnoreRules = async (
  directory: string,
  base: string,
): Promise<ReadonlyArray<IgnoreRule>> => {
  try {
    return parseIgnoreFile(await readFile(nodePath.join(directory, ".gitignore"), "utf8"), base);
  } catch {
    return [];
  }
};

export interface WalkEntry {
  /** Slash-separated and relative to the walk root, like `git ls-files`. */
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * Every non-ignored path under `root`, files and directories alike, capped at
 * `MAX_ENTRIES` so a home directory opened by mistake cannot hang the search.
 */
export const walkWorkspace = async (root: string): Promise<ReadonlyArray<WalkEntry>> => {
  const entries: Array<WalkEntry> = [];
  const visit = async (
    directory: string,
    relative: string,
    depth: number,
    inherited: ReadonlyArray<IgnoreRule>,
  ): Promise<void> => {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
    const rules = [...inherited, ...(await readIgnoreRules(directory, relative))];
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is one the user cannot search either.
      return;
    }
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of listing) {
      if (entries.length >= MAX_ENTRIES) return;
      if (child.name === ".git") continue;
      // A symlink is listed as a file — `git ls-files` lists one too — but is
      // never descended into: the walk must not escape the workspace, and a
      // cycle would never terminate. `files.read` is where a link pointing
      // outside the root is refused, by canonical containment.
      const isDirectory = child.isDirectory();
      if (!isDirectory && !child.isFile() && !child.isSymbolicLink()) continue;
      const childPath = relative === "" ? child.name : `${relative}/${child.name}`;
      if (isIgnored(rules, childPath, isDirectory)) continue;
      entries.push({ path: childPath, isDirectory });
      if (isDirectory) {
        await visit(nodePath.join(directory, child.name), childPath, depth + 1, rules);
      }
    }
  };
  await visit(root, "", 0, []);
  return entries;
};
