#!/usr/bin/env node
/**
 * Package boundary check (spec section 4, decision D4).
 *
 * Two guardrails in one pass over the workspace sources:
 *
 *  1. Import boundaries. Every `@OpenAde/*` import is checked against the
 *     allowlist below. A package may always import itself; anything else has to
 *     be listed. A package with no rule may not import any workspace package.
 *  2. The renderer connector-neutrality grep. Connector identity never reaches
 *     `apps/web`: the strings `commandcode`, the quoted literal `"cmd"` and
 *     `claude` must not appear under `apps/web/src`, outside the icon set.
 *
 * Every violation is printed as `file:line` and the process exits 1.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));

/** Workspace package short names each workspace directory may import. */
const IMPORT_ALLOWLIST = new Map([
  ["apps/web", ["ui", "contracts", "client-runtime", "shared"]],
  ["apps/desktop", ["contracts", "shared"]],
  ["apps/server", ["contracts", "connector-sdk", "connector-cmd", "shared", "testkit"]],
  ["packages/connector-sdk", ["contracts", "shared"]],
  ["packages/connector-*", ["connector-sdk", "contracts", "shared"]],
  ["packages/contracts", ["shared"]],
  ["packages/client-runtime", ["contracts", "shared"]],
  ["packages/testkit", ["contracts", "connector-sdk", "shared"]],
  ["packages/shared", []],
  ["packages/ui", []],
  ["packages/config", []],
]);

/** Decision D4: the exact patterns, and the one directory they do not apply to. */
const RENDERER_FORBIDDEN = [
  { name: "commandcode", pattern: /\bcommandcode\b/i },
  { name: '"cmd"', pattern: /"cmd"/ },
  { name: "claude", pattern: /\bclaude\b/i },
];
const RENDERER_ROOT = "apps/web/src";
const RENDERER_EXCLUDED = ["apps/web/src/components/ui/icons"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
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

/** Matches `from "x"`, bare `import "x"`, `import("x")` and `require("x")`. */
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

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

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

const violations = [];

const report = (file, line, message) => {
  violations.push(`${file}:${line}  ${message}`);
};

// ---------------------------------------------------------------- boundaries

for (const workspaceDirectory of [...listDirectories("apps"), ...listDirectories("packages")]) {
  const ownName = NodePath.basename(workspaceDirectory);
  const allowed = allowlistFor(workspaceDirectory);

  for (const file of walkSourceFiles(workspaceDirectory)) {
    const source = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
    IMPORT_PATTERN.lastIndex = 0;
    let match = IMPORT_PATTERN.exec(source);
    while (match !== null) {
      const specifier = match[1];
      const scoped = /^@OpenAde\/([^/]+)/.exec(specifier);
      if (scoped !== null) {
        const target = scoped[1];
        const line = lineOf(source, match.index);
        if (target !== ownName) {
          if (allowed === undefined) {
            report(
              file,
              line,
              `${workspaceDirectory} has no boundary rule; add one to scripts/check-boundaries.mjs before importing ${specifier}`,
            );
          } else if (!allowed.includes(target)) {
            report(
              file,
              line,
              `${workspaceDirectory} may not import @OpenAde/${target} (allowed: ${
                allowed.length === 0 ? "none" : allowed.join(", ")
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

for (const file of walkSourceFiles(RENDERER_ROOT)) {
  if (RENDERER_EXCLUDED.some((excluded) => file.startsWith(excluded))) {
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
