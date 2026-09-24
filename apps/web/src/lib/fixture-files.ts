/**
 * The fixture workspace's files, for `files.stat` and `files.read`: the paths
 * the timeline fixture's messages and tool rows name, and every directory
 * above them. The
 * answer follows the server's rules — a relative path resolves against the
 * root, an absolute one counts only under it, `..` never climbs out and the
 * root itself is not reported — so a fixture page sees the same set of
 * confirmed paths a real workspace would give it.
 */

import type { FileContent, FileStat } from "@OpenAde/contracts/rpc";

/** Where the fixture project lives. Nothing is on disk there. */
export const FIXTURE_ROOT = "/fixture";

const FILES = [
  "README.md",
  "package.json",
  "docs/architecture.md",
  "src/app.ts",
  "src/app.tsx",
  "src/components/composer.tsx",
  "src/routes/index.tsx",
  "scripts/deploy.sh",
  "scripts/smoke.sh",
  "apps/server/src/http/health.ts",
  "apps/server/src/http/metrics.ts",
  "apps/server/src/http/ready.ts",
  "apps/server/src/http/router.ts",
  "apps/server/src/http/routes.gen.ts",
  "apps/web/src/main.tsx",
  "apps/web/src/lib/format.ts",
  "apps/web/src/settings/banner.tsx",
  "apps/web/src/settings/banner.test.tsx",
  "apps/web/src/settings/save-modal.tsx",
  "packages/contracts/src/orchestration.ts",
  "packages/contracts/src/rpc.ts",
  "packages/shared/src/format.ts",
];

/** Every fixture file is this long, except the one kept long enough to page. */
const FILE_LINES = 180;
const LONG_FILE = "packages/contracts/src/rpc.ts";
const LONG_FILE_LINES = 760;

const DIRECTORIES = new Set(
  FILES.flatMap((file) =>
    file
      .split("/")
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
  ),
);

/** `path` as a root-relative path with `.` and `..` folded away, or null when it leaves the root. */
const relativeTo = (path: string): string | null => {
  let rest = path;
  if (path.startsWith("/")) {
    if (!path.startsWith(`${FIXTURE_ROOT}/`)) return null;
    rest = path.slice(FIXTURE_ROOT.length + 1);
  }
  const parts: Array<string> = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
};

/** What `files.stat` answers in the fixture: the asked paths that exist, each once, in order. */
export const fixtureStat = (paths: ReadonlyArray<string>): ReadonlyArray<FileStat> =>
  [...new Set(paths)].flatMap((path): Array<FileStat> => {
    const relativePath = relativeTo(path);
    if (relativePath === null) return [];
    const isDirectory = DIRECTORIES.has(relativePath);
    if (!isDirectory && !FILES.includes(relativePath)) return [];
    return [{ path, relativePath, absolutePath: `${FIXTURE_ROOT}/${relativePath}`, isDirectory }];
  });

/**
 * What `files.read` answers in the fixture: numbered placeholder lines, so the
 * Files tab can page a file and show the line a chip opened it at. Null for a
 * path that is not a fixture file.
 */
export const fixtureRead = (path: string, offset = 0, limit = FILE_LINES): FileContent | null => {
  const relativePath = relativeTo(path);
  if (relativePath === null || !FILES.includes(relativePath)) return null;
  const totalLines = relativePath === LONG_FILE ? LONG_FILE_LINES : FILE_LINES;
  const end = Math.min(totalLines, offset + limit);
  const lines = Array.from(
    { length: Math.max(0, end - offset) },
    (_, index) => `// ${relativePath}, line ${offset + index + 1}`,
  );
  return { path: relativePath, text: lines.join("\n"), totalLines, truncated: false };
};
