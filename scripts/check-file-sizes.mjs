#!/usr/bin/env node
/**
 * File size guardrail (spec section 16).
 *
 *  - No non-test source file over 800 lines anywhere in the workspace.
 *  - No renderer component under `apps/web/src/components` over 400 lines.
 *
 * Tests, fixtures and generated files are exempt: they grow for reasons that
 * splitting does not help. Every offender is printed as `file:line` (the line
 * that broke the budget) and the process exits 1.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));

const MAX_LINES = 800;
const MAX_COMPONENT_LINES = 400;
const COMPONENT_ROOT = "apps/web/src/components";

const SCAN_ROOTS = ["apps", "packages", "scripts"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "artifacts",
  "fixtures",
  "__fixtures__",
  ".turbo",
  ".git",
  ".vite",
  "coverage",
]);

const SKIPPED_FILES = new Set(["routeTree.gen.ts"]);

/** `*.test.*` and `*.spec.*` in any of the source extensions. */
const isTestFile = (name) => /\.(test|spec)\./.test(name);

const isGenerated = (name) => SKIPPED_FILES.has(name) || name.endsWith(".gen.ts");

const walk = (relative, files) => {
  const full = NodePath.join(ROOT, relative);
  if (!NodeFS.existsSync(full)) {
    return files;
  }
  for (const entry of NodeFS.readdirSync(full, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        walk(child, files);
      }
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(NodePath.extname(entry.name)) &&
      !isTestFile(entry.name) &&
      !isGenerated(entry.name)
    ) {
      files.push(child);
    }
  }
  return files;
};

const files = SCAN_ROOTS.flatMap((root) => walk(root, []));

const violations = [];

for (const file of files.sort()) {
  const lines = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8").split("\n").length;
  const budget = file.startsWith(`${COMPONENT_ROOT}/`) ? MAX_COMPONENT_LINES : MAX_LINES;
  if (lines > budget) {
    violations.push(`${file}:${budget + 1}  ${lines} lines, budget is ${budget}`);
  }
}

if (violations.length > 0) {
  console.error(`check-file-sizes: ${violations.length} file(s) over budget\n`);
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error("");
  process.exit(1);
}

console.log(`check-file-sizes: ok (${files.length} files)`);
