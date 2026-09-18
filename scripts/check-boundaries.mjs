#!/usr/bin/env node
/**
 * Package boundary check (spec section 4, decision D4).
 *
 * Two guardrails in one pass over the workspace sources:
 *
 *  1. Import boundaries. Every import that names another workspace package is
 *     checked against the allowlist below — the scoped `@OpenAde/*` packages
 *     and the three unscoped apps (`web`, `desktop`, `server`) alike. A package
 *     may always import itself; anything else has to be listed. A package with
 *     no rule may not import any workspace package. A relative specifier that
 *     climbs out of its own workspace directory is a violation whatever it
 *     lands on: packages are consumed through their `exports` map (D1), so
 *     `../../../packages/testkit/src/receipts` is a boundary crossing wearing a
 *     path.
 *  2. The renderer connector-neutrality grep. Connector identity never reaches
 *     `apps/web`: the strings `commandcode`, the quoted literal `"cmd"` and
 *     `claude` must not appear under `apps/web/src`, outside the icon set.
 *     Every file counts, not only the source ones — a connector name reads the
 *     same in a CSS class, an SVG title, a JSON label or a file name.
 *  3. No barrel files. A package exports one entry per module through its
 *     `exports` map (spec section 4, D1), so an `index.ts` anywhere under a
 *     `packages/` workspace is refused. Apps are not covered: the router's
 *     `routes/settings/index.tsx` is a route, not a barrel, and the Electron
 *     entry points are named by electron-builder.
 *
 * Every violation is printed as `file:line` and the process exits 1.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));

/**
 * Workspace package short names each workspace directory may import.
 *
 * Spec section 4 writes the renderer rule as "web imports only contracts,
 * client-runtime, shared". `ui` is added because the pre-existing design system
 * stays and apps/web renders through it (00-plan-adaptation, "Root and layout";
 * 02-w0-contract-notes, N4). This list is the enforced rule.
 */
const IMPORT_ALLOWLIST = new Map([
  ["apps/web", ["ui", "contracts", "client-runtime", "shared"]],
  ["apps/desktop", ["contracts", "shared"]],
  ["apps/server", ["contracts", "connector-sdk", "connector-cmd", "shared"]],
  ["packages/connector-sdk", ["contracts", "shared"]],
  ["packages/connector-*", ["connector-sdk", "contracts", "shared"]],
  ["packages/contracts", ["shared"]],
  ["packages/client-runtime", ["contracts", "shared"]],
  ["packages/testkit", ["contracts", "connector-sdk", "shared"]],
  ["packages/shared", []],
  ["packages/ui", []],
  ["packages/config", []],
]);

/**
 * What a workspace's *test* files may import on top of its own allowlist.
 *
 * `@OpenAde/testkit` is the fakes and the receipt helpers; the server drives
 * them from its tests and must never ship them, because apps/server is bundled
 * to `out/main.cjs` for packaging (D1). `@OpenAde/client-runtime` joins in
 * tests for W3's transport suite, which exercises the real client against the
 * real server over a WebSocket. Keeping both out of the production list is
 * what makes an accidental import in `src/main.ts` fail the gate.
 */
const TEST_ONLY_ALLOWLIST = new Map([["apps/server", ["testkit", "client-runtime"]]]);

/**
 * A `*.test.ts` file, or anything under a workspace's `test/` directory.
 *
 * The second half is for suites too big to live in one file: the end-to-end
 * scenarios under `apps/server/test/e2e/` share a harness that dials the
 * server with the real client runtime, and a harness is not a `.test.ts`. The
 * directory is the statement of intent — nothing under it is bundled, because
 * `apps/server`'s esbuild entry is `src/main.ts` — so it carries the same
 * allowance the test files themselves do.
 */
const isTestFile = (file) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split("/").includes("test");

/**
 * Decision D4: the exact patterns, and the one directory they do not apply to.
 *
 * `commandcode` matches the spaced spelling too. The one-word form was the
 * only thing the pattern caught, so "Command Code" walked straight through it
 * — and did, in the Skills page's own description, which named one connector
 * on a page that renders whichever connector is configured.
 */
const RENDERER_FORBIDDEN = [
  { name: "commandcode", pattern: /\bcommand\s*code\b/i },
  { name: '"cmd"', pattern: /"cmd"/ },
  { name: "claude", pattern: /\bclaude\b/i },
];
const RENDERER_ROOT = "apps/web/src";
const RENDERER_EXCLUDED = ["apps/web/src/components/ui/icons"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Files the neutrality grep reads by name only; their bytes are not text. */
const OPAQUE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".icns",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
]);

/** Barrels are refused here; apps keep their route and entry-point index files. */
const BARREL_NAMES = new Set(["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "artifacts",
  ".turbo",
  ".git",
  ".vite",
  "coverage",
]);

/**
 * Matches `from "x"`, bare `import "x"`, `import("x")` and `require("x")`.
 *
 * Backticks count: `import(\`@OpenAde/${name}/ids\`)` is still a boundary
 * crossing, and a template literal whose package segment is static is exactly
 * how one would be written to slip past a quote-only pattern.
 */
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(?:["']([^"']+)["']|`([^`]+)`)/g;

const listDirectories = (parent) => {
  const full = NodePath.join(ROOT, parent);
  if (!NodeFS.existsSync(full)) {
    return [];
  }
  return NodeFS.readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
};

const walkSourceFiles = (relativeDirectory) => {
  const files = [];
  const visit = (relative) => {
    const full = NodePath.join(ROOT, relative);
    if (!NodeFS.existsSync(full)) {
      return;
    }
    for (const entry of NodeFS.readdirSync(full, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(child);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(NodePath.extname(entry.name))) {
        files.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return files.sort();
};

/** Every file under a directory, whatever its extension. */
const walkAllFiles = (relativeDirectory) => {
  const files = [];
  const visit = (relative) => {
    const full = NodePath.join(ROOT, relative);
    if (!NodeFS.existsSync(full)) {
      return;
    }
    for (const entry of NodeFS.readdirSync(full, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(child);
        }
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return files.sort();
};

const allowlistFor = (workspaceDirectory) => {
  const exact = IMPORT_ALLOWLIST.get(workspaceDirectory);
  if (exact !== undefined) {
    return exact;
  }
  for (const [key, allowed] of IMPORT_ALLOWLIST) {
    if (!key.endsWith("*")) {
      continue;
    }
    if (workspaceDirectory.startsWith(key.slice(0, -1))) {
      return allowed;
    }
  }
  return undefined;
};

const WORKSPACE_DIRECTORIES = [...listDirectories("apps"), ...listDirectories("packages")].filter(
  (directory) => NodeFS.existsSync(NodePath.join(ROOT, directory, "package.json")),
);

/**
 * Published package name -> workspace directory, for every workspace.
 *
 * Apps are unscoped (D1), so `web`, `desktop` and `server` are import targets
 * that no `@OpenAde/` prefix would ever reveal.
 */
const WORKSPACE_BY_PACKAGE_NAME = new Map(
  WORKSPACE_DIRECTORIES.map((directory) => [
    JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, directory, "package.json"), "utf8")).name,
    directory,
  ]),
);

/** The short name a boundary rule uses for a workspace: the directory's basename. */
const shortNameOf = (workspaceDirectory) => NodePath.basename(workspaceDirectory);

/**
 * What a specifier resolves to, seen from `file` inside `workspaceDirectory`.
 *
 * `{ kind: "workspace" }` names another workspace package, however it was
 * spelled. `{ kind: "escape" }` is a relative path that leaves the workspace
 * directory. Anything else — a node_modules package, a path inside the same
 * workspace — is not a boundary question and comes back `null`.
 */
const classifySpecifier = (specifier, file, workspaceDirectory) => {
  if (specifier.startsWith(".")) {
    const resolved = NodePath.posix.normalize(
      NodePath.posix.join(NodePath.posix.dirname(file), specifier),
    );
    if (resolved === workspaceDirectory || resolved.startsWith(`${workspaceDirectory}/`)) {
      return null;
    }
    const landing = WORKSPACE_DIRECTORIES.find(
      (directory) => resolved === directory || resolved.startsWith(`${directory}/`),
    );
    return { kind: "escape", resolved, landing: landing ?? null };
  }
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const directory = WORKSPACE_BY_PACKAGE_NAME.get(packageName);
  return directory === undefined
    ? null
    : { kind: "workspace", packageName, target: shortNameOf(directory) };
};

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

const violations = [];

const report = (file, line, message) => {
  violations.push(`${file}:${line}  ${message}`);
};

// ---------------------------------------------------------------- boundaries

for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
  const ownName = shortNameOf(workspaceDirectory);
  const allowed = allowlistFor(workspaceDirectory);

  const testExtras = TEST_ONLY_ALLOWLIST.get(workspaceDirectory) ?? [];

  for (const file of walkSourceFiles(workspaceDirectory)) {
    const allowedHere =
      allowed !== undefined && isTestFile(file) ? [...allowed, ...testExtras] : allowed;
    const source = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
    IMPORT_PATTERN.lastIndex = 0;
    let match = IMPORT_PATTERN.exec(source);
    while (match !== null) {
      const specifier = match[1] ?? match[2];
      const resolution = classifySpecifier(specifier, file, workspaceDirectory);
      if (resolution !== null) {
        const line = lineOf(source, match.index);
        if (resolution.kind === "escape") {
          report(
            file,
            line,
            resolution.landing === null
              ? `${specifier} climbs out of ${workspaceDirectory}; a package only imports its own files by path`
              : `${specifier} reaches into ${resolution.landing} by path; import ${shortNameOf(
                  resolution.landing,
                )} by its package name so the boundary rule applies`,
          );
        } else if (resolution.target !== ownName) {
          if (allowedHere === undefined) {
            report(
              file,
              line,
              `${workspaceDirectory} has no boundary rule; add one to scripts/check-boundaries.mjs before importing ${specifier}`,
            );
          } else if (!allowedHere.includes(resolution.target)) {
            report(
              file,
              line,
              `${workspaceDirectory} may not import ${resolution.packageName} (allowed: ${
                allowedHere.length === 0 ? "none" : allowedHere.join(", ")
              })`,
            );
          }
        }
      }
      match = IMPORT_PATTERN.exec(source);
    }
  }
}

// ------------------------------------------------- renderer neutrality (D4)

for (const file of walkAllFiles(RENDERER_ROOT)) {
  if (RENDERER_EXCLUDED.some((excluded) => file.startsWith(excluded))) {
    continue;
  }
  for (const { name, pattern } of RENDERER_FORBIDDEN) {
    if (pattern.test(NodePath.basename(file))) {
      report(file, 1, `connector identity leaked into a renderer file name: ${name}`);
    }
  }
  if (OPAQUE_EXTENSIONS.has(NodePath.extname(file))) {
    continue;
  }
  const lines = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8").split("\n");
  lines.forEach((text, index) => {
    for (const { name, pattern } of RENDERER_FORBIDDEN) {
      if (pattern.test(text)) {
        report(file, index + 1, `connector identity leaked into the renderer: ${name}`);
      }
    }
  });
}

// --------------------------------------------------------------- no barrels

for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
  if (!workspaceDirectory.startsWith("packages/")) {
    continue;
  }
  for (const file of walkSourceFiles(workspaceDirectory)) {
    if (BARREL_NAMES.has(NodePath.basename(file))) {
      report(
        file,
        1,
        `barrel file: ${workspaceDirectory} exports one entry per module through package.json "exports" (spec section 4)`,
      );
    }
  }
}

// ------------------------------------------------------------------ verdict

if (violations.length > 0) {
  console.error(`check-boundaries: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error("");
  process.exit(1);
}

console.log("check-boundaries: ok");
