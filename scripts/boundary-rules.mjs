/**
 * The rules `check-boundaries.mjs` applies, as pure functions of a path and
 * its text.
 *
 * The walker in `check-boundaries.mjs` reads the tree and reports; everything
 * that decides whether a file is in violation lives here so that
 * `boundary-rules.test.mjs` can exercise each rule on a handful of strings
 * rather than on a doctored checkout. Every matcher returns a list of
 * `{ line, message }`, empty when the file is fine.
 */

// ------------------------------------------------------------ import allowlist

/**
 * Workspace package short names each workspace directory may import.
 *
 * The renderer's rule is contracts, client-runtime and shared, plus `ui`:
 * the design system predates this app and apps/web renders through it. This
 * list is the enforced rule (docs/architecture.md, "Boundaries").
 *
 * `apps/server` does not get a connector package here: only its composition
 * root does (`FILE_ALLOWLIST`), and its tests (`TEST_ONLY_ALLOWLIST`).
 */
export const IMPORT_ALLOWLIST = new Map([
  ["apps/web", ["ui", "contracts", "client-runtime", "shared"]],
  ["apps/desktop", ["contracts", "shared"]],
  ["apps/server", ["contracts", "connector-sdk", "shared"]],
  // W11: the public site is static — it may share the design system and the
  // tiny utils but never contracts, the client runtime or server code.
  ["apps/site", ["ui", "shared"]],
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
 * to `out/main.cjs` for packaging. `@OpenAde/client-runtime` joins in
 * tests for the transport suite, which exercises the real client against the
 * real server over a WebSocket. `@OpenAde/connector-cmd` and
 * `@OpenAde/connector-claude` are here because a conformance or end-to-end
 * test assembles a real connector the same way the composition root does.
 * Keeping them all out of the production list is what makes an accidental
 * import in `src/main.ts` fail the gate.
 *
 * The Claude Code connector's own tests replay its recordings through
 * testkit's `sdk-stream` replayer and record them through its tee, so they
 * get testkit too; the connector's sources never do.
 */
export const TEST_ONLY_ALLOWLIST = new Map([
  ["apps/server", ["testkit", "client-runtime", "connector-cmd", "connector-claude"]],
  ["packages/connector-claude", ["testkit"]],
]);

/**
 * Single files that may import more than their workspace.
 *
 * The server's composition root is the one place that names the concrete
 * connectors: it builds the registry from each connector's definition, and
 * everything else in `apps/server` reaches connectors through the registry.
 */
export const FILE_ALLOWLIST = new Map([
  ["apps/server/src/boot.ts", ["connector-cmd", "connector-claude"]],
]);

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
export const isTestFile = (file) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split("/").includes("test");

const workspaceAllowlist = (workspaceDirectory) => {
  const exact = IMPORT_ALLOWLIST.get(workspaceDirectory);
  if (exact !== undefined) {
    return exact;
  }
  for (const [key, allowed] of IMPORT_ALLOWLIST) {
    if (key.endsWith("*") && workspaceDirectory.startsWith(key.slice(0, -1))) {
      return allowed;
    }
  }
  return undefined;
};

/**
 * The workspace short names `file` may import, or `undefined` when its
 * workspace has no rule at all.
 */
export const allowedImportsFor = (file, workspaceDirectory) => {
  const allowed = workspaceAllowlist(workspaceDirectory);
  if (allowed === undefined) {
    return undefined;
  }
  const testExtras = isTestFile(file) ? (TEST_ONLY_ALLOWLIST.get(workspaceDirectory) ?? []) : [];
  return [...allowed, ...testExtras, ...(FILE_ALLOWLIST.get(file) ?? [])];
};

/**
 * Matches `from "x"`, bare `import "x"`, `import("x")` and `require("x")`.
 *
 * Backticks count: `import(\`@OpenAde/${name}/ids\`)` is still a boundary
 * crossing, and a template literal whose package segment is static is exactly
 * how one would be written to slip past a quote-only pattern.
 */
export const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(?:["']([^"']+)["']|`([^`]+)`)/g;

/** Every import specifier in `source`, with the offset it starts at. */
export const importSpecifiers = (source) =>
  [...source.matchAll(IMPORT_PATTERN)].map((match) => ({
    specifier: match[1] ?? match[2],
    index: match.index,
  }));

export const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// ------------------------------------------------------------- connector leaks

/**
 * Where no concrete connector may be named: the renderer, the client runtime
 * and the server. They reach a connector through the registry and the
 * contracts, so a harness is added without touching them.
 */
const CONNECTOR_NEUTRAL_ROOTS = ["apps/web/", "packages/client-runtime/", "apps/server/"];

/** The one server file that assembles concrete connectors. */
const COMPOSITION_ROOT = "apps/server/src/boot.ts";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** A workspace connector package other than the SDK every connector builds on. */
const CONNECTOR_PACKAGE = /^@OpenAde\/connector-(?!sdk(?:\/|$))[^/]+/;

/**
 * A quoted connector kind. `ConnectorKind` values travel as data (the
 * registry, `connectors.describe`); code that compares against one by name is
 * branching on a specific harness.
 */
const KIND_LITERAL = /["'`](cmd|claude|codex|opencode)["'`]/;

/**
 * Files the kind-literal rule does not read, each with the reason.
 *
 * The pattern stays as strict as it is; a legitimate use of the same word is
 * listed here by exact path instead.
 */
export const KIND_LITERAL_EXEMPT = new Map([
  [
    "packages/client-runtime/src/keybindings.ts",
    '"cmd" is the macOS Command key in a shortcut like "cmd+k", not a connector kind',
  ],
]);

/**
 * Concrete-connector leaks in a non-test source file of the renderer, the
 * client runtime or the server: an import of a connector package, or a quoted
 * connector kind.
 *
 * Tests are exempt — `cmdConformance.test.ts`, `attachmentTurn.test.ts`,
 * `boot.test.ts` and the end-to-end harness under `test/` assemble the real
 * connector on purpose — and so is the composition root, `boot.ts`.
 */
export const connectorLeaks = (relativePath, text) => {
  if (
    !CONNECTOR_NEUTRAL_ROOTS.some((root) => relativePath.startsWith(root)) ||
    !SOURCE_FILE.test(relativePath) ||
    isTestFile(relativePath) ||
    relativePath === COMPOSITION_ROOT
  ) {
    return [];
  }
  const leaks = [];
  for (const { specifier, index } of importSpecifiers(text)) {
    const connectorPackage = CONNECTOR_PACKAGE.exec(specifier);
    if (connectorPackage !== null) {
      leaks.push({
        line: lineOf(text, index),
        message: `${connectorPackage[0]} is a concrete connector; only ${COMPOSITION_ROOT} and tests may import one`,
      });
    }
  }
  if (!KIND_LITERAL_EXEMPT.has(relativePath)) {
    text.split("\n").forEach((line, index) => {
      const kind = KIND_LITERAL.exec(line);
      if (kind !== null) {
        leaks.push({
          line: index + 1,
          message: `connector kind literal "${kind[1]}"; take the kind from the registry or the contracts instead`,
        });
      }
    });
  }
  return leaks;
};

// -------------------------------------------------------- renderer neutrality

/**
 * The exact patterns, and the one directory they do not apply to.
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
  { name: "codex", pattern: /\bcodex\b/i },
  { name: "opencode", pattern: /\bopencode\b/i },
];
const RENDERER_ROOT = "apps/web/src/";
const RENDERER_EXCLUDED = ["apps/web/src/components/ui/icons/"];

/**
 * Connector identity in a renderer file: its name, or — unless `text` is
 * `null` because the file is binary — its contents. Every file counts, not
 * only the source ones: a connector name reads the same in a CSS class, an
 * SVG title, a JSON label or a file name.
 */
export const rendererLeaks = (relativePath, text) => {
  if (
    !relativePath.startsWith(RENDERER_ROOT) ||
    RENDERER_EXCLUDED.some((excluded) => relativePath.startsWith(excluded))
  ) {
    return [];
  }
  const leaks = [];
  const basename = relativePath.split("/").at(-1);
  for (const { name, pattern } of RENDERER_FORBIDDEN) {
    if (pattern.test(basename)) {
      leaks.push({
        line: 1,
        message: `connector identity leaked into a renderer file name: ${name}`,
      });
    }
  }
  if (text !== null) {
    text.split("\n").forEach((line, index) => {
      for (const { name, pattern } of RENDERER_FORBIDDEN) {
        if (pattern.test(line)) {
          leaks.push({
            line: index + 1,
            message: `connector identity leaked into the renderer: ${name}`,
          });
        }
      }
    });
  }
  return leaks;
};

// ------------------------------------------------------------ reference names

/**
 * Names of other products this one was compared against while it was built.
 * They are kept base64-encoded so that the guard does not spell them, and
 * decoded once here; the tests build their inputs from the same list.
 */
export const REFERENCE_NAMES = [
  "enVzZQ==",
  "dDNjb2Rl",
  "dDMgY29kZQ==",
  "c3luYXJh",
  "b3BlbmNvZGV4",
].map((encoded) => atob(encoded));

/** Case-insensitive; a space in a name also matches `-`, `_` or nothing. */
const REFERENCE_PATTERNS = REFERENCE_NAMES.map(
  (name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s_-]*"), "i"),
);

const REFERENCE_ROOTS = ["apps/", "packages/", "scripts/"];

/** Top-level markdown only: `docs/plans/` is local notes, not the product. */
const REFERENCE_DOCS = /^docs\/[^/]+\.md$/;

/** Build output and dependencies: not written by us. */
export const REFERENCE_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-ssr", "out"]);

/** Whether the reference-name rule reads `relativePath` at all. */
export const referenceNameApplies = (relativePath) =>
  (REFERENCE_ROOTS.some((root) => relativePath.startsWith(root)) ||
    REFERENCE_DOCS.test(relativePath)) &&
  !relativePath.split("/").some((segment) => REFERENCE_SKIPPED_DIRECTORIES.has(segment));

/**
 * A reference-product name in a path or, unless `text` is `null` because the
 * file is binary, in its contents. Describe an idea in our own words instead.
 */
export const referenceNameLeaks = (relativePath, text) => {
  if (!referenceNameApplies(relativePath)) {
    return [];
  }
  const leaks = [];
  if (REFERENCE_PATTERNS.some((pattern) => pattern.test(relativePath))) {
    leaks.push({ line: 1, message: "a reference-product name in a file path" });
  }
  if (text !== null) {
    text.split("\n").forEach((line, index) => {
      if (REFERENCE_PATTERNS.some((pattern) => pattern.test(line))) {
        leaks.push({
          line: index + 1,
          message: "a reference-product name; describe the idea in our own words",
        });
      }
    });
  }
  return leaks;
};

// ----------------------------------------------------------- bold icons

/** Where the bold-icon rule reads: every `.tsx` file of an app or a package. */
const BOLD_ICON_FILE = /^(?:apps|packages)\/.+\.tsx$/;

/** A value import from the icon package, the only place icon components come from. */
const HONEYICONS_IMPORT = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@honeyicons\/react["']/g;

/**
 * The local names a file binds to Honeyicons components: every value
 * specifier of an import from `@honeyicons/react`, under its alias when it
 * has one. Type-only imports and specifiers (`type HoneyIcon`) are not
 * components and are left out.
 */
export const honeyiconNames = (text) => {
  const names = new Set();
  for (const match of text.matchAll(HONEYICONS_IMPORT)) {
    if (match[1] !== undefined) {
      continue;
    }
    for (const raw of match[2].split(",")) {
      const specifier = raw.trim();
      if (specifier === "" || /^type\s/.test(specifier)) {
        continue;
      }
      names.add(
        specifier
          .split(/\s+as\s+/)
          .at(-1)
          .trim(),
      );
    }
  }
  return names;
};

/**
 * The attribute text of the JSX opening that starts at `start` (just past the
 * tag name), up to its closing `>`. Braces and quoted strings are skipped, so
 * an arrow function or a `>` inside a class name does not end the tag early.
 */
const openingAttributes = (text, start) => {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === ">" && depth === 0) {
      return text.slice(start, index);
    }
  }
  return text.slice(start);
};

const BOLD_VARIANT = /(?:^|\s)variant=(?:"bold"|'bold'|\{\s*["']bold["']\s*\})/;
const SPREAD_ATTRIBUTE = /\{\s*\.\.\./;

/**
 * JSX renderings of a Honeyicons component without `variant="bold"`.
 *
 * Every icon ships a linear and a bold drawing and renders linear unless told
 * otherwise; the package has no provider for a default, so the app-wide
 * choice of bold is spelled on each element. An element that spreads props
 * passes: the spread is where the caller's `variant="bold"` arrives. A tag is
 * any `<Name` that is not preceded by an identifier character, which keeps
 * type arguments such as `Record<string, Name>` out.
 */
export const boldIconLeaks = (relativePath, text) => {
  if (!BOLD_ICON_FILE.test(relativePath)) {
    return [];
  }
  const names = honeyiconNames(text);
  if (names.size === 0) {
    return [];
  }
  const leaks = [];
  for (const match of text.matchAll(/(?<![\w$.])<([A-Z][\w$]*)(?=[\s/>])/g)) {
    const name = match[1];
    if (!names.has(name)) {
      continue;
    }
    const attributes = openingAttributes(text, match.index + match[0].length);
    if (!BOLD_VARIANT.test(attributes) && !SPREAD_ATTRIBUTE.test(attributes)) {
      leaks.push({
        line: lineOf(text, match.index),
        message: `<${name}> renders the linear icon; add variant="bold" (icons render the bold variant app-wide)`,
      });
    }
  }
  return leaks;
};
