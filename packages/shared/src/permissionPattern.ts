/**
 * Poseidon's permission patterns, parsed and matched.
 *
 * This is Poseidon's own vocabulary, the same whichever harness runs the
 * thread. A connector maps its harness's tool names onto it (the "allow
 * always" suggestion it proposes); the rules the settings document and
 * `approval.respond.pattern` store are written in it:
 *
 * - `Shell(npm run *)`       — command glob; `*` matches anything, `?` one char
 * - `Edit(/src/**)`          — path glob over writes; `**` crosses separators
 * - `Read(/docs/**)`         — the same, over reads
 * - `Fetch(https://x.dev/*)` — glob over a web request's url or search query
 * - `Mcp(github.create_*)`   — glob over an MCP call's `server.tool`
 * - `todo_write`             — bare tool name, matched exactly or as a glob
 *
 * Rules stored before the vocabulary was Poseidon's own stay valid as aliases:
 * `Write(...)` is `Edit(...)`, `WebFetch(...)` and `WebSearch(...)` are
 * `Fetch(...)`, and a literal `mcp__server__tool` is still globbed against the
 * tool name of an MCP request.
 *
 * The subject a pattern tests comes from the request's `kind`, `input` and
 * `mcpTool`: `command` requests carry `input.command`, file requests
 * `input.path`, web requests `input.url`/`input.query`, MCP requests the
 * `mcpTool` their connector named.
 *
 * This module lives in shared so the renderer can preview a pattern against
 * the live request with the exact matcher the server enforces — one syntax,
 * one semantics, one source of truth. It is dependency-free on purpose:
 * `ApprovalRequest` satisfies `PatternSubject` structurally, so neither side
 * needs to import the other.
 */

/** The MCP server and tool a call goes to, as its connector names them. */
export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

/**
 * What a pattern is matched against. `ApprovalRequest` in
 * `@poseidon/contracts/runtime` is a superset of this shape; the field types
 * here are deliberately wide (`kind` is a plain string) so the matcher never
 * needs the contracts package.
 */
export interface PatternSubject {
  readonly kind: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly mcpTool?: McpToolRef | undefined;
}

/**
 * - `shell`, `edit`, `read`, `fetch`, `mcp` — the call forms above.
 * - `mcp-name` — a stored `mcp__server__tool` literal, globbed over `toolName`.
 * - `tool` — a bare tool name.
 */
export type PatternFamily = "shell" | "edit" | "read" | "fetch" | "mcp" | "mcp-name" | "tool";

export interface ParsedPattern {
  readonly family: PatternFamily;
  /** The `(...)` argument, or the whole pattern for bare/mcp-name forms. */
  readonly arg: string | null;
  readonly source: string;
}

/** Call-form names, lower-cased, canonical and alias alike. */
const FAMILY_NAMES: Readonly<Record<string, PatternFamily>> = {
  shell: "shell",
  edit: "edit",
  write: "edit",
  read: "read",
  fetch: "fetch",
  webfetch: "fetch",
  websearch: "fetch",
  mcp: "mcp",
};

/** `Family(arg)` → `{family, arg}`; bare names fall through to tool/mcp-name. */
export const parsePattern = (pattern: string): ParsedPattern | null => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const call = /^([A-Za-z]+)\((.*)\)$/s.exec(trimmed);
  if (call !== null) {
    const family = FAMILY_NAMES[call[1]!.toLowerCase()];
    if (family === undefined) {
      return null;
    }
    return { family, arg: call[2]!.trim(), source: trimmed };
  }
  if (trimmed.startsWith("mcp__")) {
    return { family: "mcp-name", arg: trimmed, source: trimmed };
  }
  return { family: "tool", arg: trimmed, source: trimmed };
};

const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** Shell-style glob where `*` spans anything (arguments included). */
const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split("")
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char)))
      .join("")}$`,
  );

/** Path glob: `**` crosses `/`, `*` stays within a segment, `?` one char. */
const pathGlobToRegExp = (glob: string): RegExp => {
  const parts: Array<string> = [];
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      parts.push(".*");
      i++;
    } else if (char === "*") {
      parts.push("[^/]*");
    } else if (char === "?") {
      parts.push("[^/]");
    } else {
      parts.push(escapeRegExp(char));
    }
  }
  return new RegExp(`^${parts.join("")}$`);
};

const inputString = (input: unknown, ...keys: ReadonlyArray<string>): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
};

/** The file path a file-kind request is about, or null. */
export const requestPath = (request: PatternSubject): string | null =>
  inputString(request.input, "path", "file_path", "filePath", "file");

/** The command a command-kind request is about, or null. */
export const requestCommand = (request: PatternSubject): string | null =>
  inputString(request.input, "command", "cmd");

/** The URL or query a web-kind request is about, or null. */
export const requestUrl = (request: PatternSubject): string | null =>
  inputString(request.input, "url", "query");

/**
 * Whether a parsed pattern matches the request. An unmatched request kind is
 * simply false — a `Shell(...)` rule says nothing about a file write.
 */
export const matchPattern = (pattern: ParsedPattern, request: PatternSubject): boolean => {
  switch (pattern.family) {
    case "shell": {
      if (request.kind !== "command" || pattern.arg === null) {
        return false;
      }
      const command = requestCommand(request);
      return command !== null && globToRegExp(pattern.arg).test(command);
    }
    case "edit": {
      if (request.kind !== "file_write" || pattern.arg === null) {
        return false;
      }
      const path = requestPath(request);
      return path !== null && pathGlobToRegExp(pattern.arg).test(path);
    }
    case "read": {
      if (request.kind !== "file_read" || pattern.arg === null) {
        return false;
      }
      const path = requestPath(request);
      return path !== null && pathGlobToRegExp(pattern.arg).test(path);
    }
    case "fetch": {
      if (request.kind !== "web" || pattern.arg === null) {
        return false;
      }
      const url = requestUrl(request);
      return url !== null && globToRegExp(pattern.arg).test(url);
    }
    case "mcp": {
      const ref = request.mcpTool;
      return (
        request.kind === "mcp_tool" &&
        ref !== undefined &&
        pattern.arg !== null &&
        globToRegExp(pattern.arg).test(`${ref.server}.${ref.tool}`)
      );
    }
    case "mcp-name":
      return (
        request.kind === "mcp_tool" &&
        pattern.arg !== null &&
        globToRegExp(pattern.arg).test(request.toolName)
      );
    case "tool":
      return pattern.arg !== null && globToRegExp(pattern.arg).test(request.toolName);
  }
};

/** Parse + match in one step; unparseable patterns match nothing. */
export const patternMatches = (source: string, request: PatternSubject): boolean => {
  const parsed = parsePattern(source);
  return parsed !== null && matchPattern(parsed, request);
};
