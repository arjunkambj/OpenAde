/**
 * Command Code permission patterns, parsed and matched.
 *
 * Syntax the settings document and `approval.respond.pattern` accept:
 *
 * - `Shell(npm run *)`      — command glob; `*` matches anything, `?` one char
 * - `Edit(/src/**)`         — path glob; `**` crosses separators, `*` doesn't
 * - `Write(...)`, `Read(...)`, `WebFetch(...)`, `WebSearch(...)`
 * - `mcp__server__tool`     — MCP tool reference (glob over the tool name)
 * - `shell_command`         — bare tool name, matched exactly or as a glob
 *
 * The subject a pattern tests comes from the request's `kind` and `input`:
 * `command` requests carry `input.command`, file requests `input.path`, web
 * requests `input.url`/`input.query`, MCP requests the `toolName` itself.
 */

import type { ApprovalRequest } from "@OpenAde/contracts/runtime";

export type PatternFamily =
  | "shell"
  | "edit"
  | "write"
  | "read"
  | "webfetch"
  | "websearch"
  | "mcp"
  | "tool";

export interface ParsedPattern {
  readonly family: PatternFamily;
  /** The `(...)` argument, or the whole pattern for bare/mcp forms. */
  readonly arg: string | null;
  readonly source: string;
}

const FAMILY_NAMES: Readonly<Record<string, PatternFamily>> = {
  shell: "shell",
  edit: "edit",
  write: "write",
  read: "read",
  webfetch: "webfetch",
  websearch: "websearch",
};

/** `Family(arg)` → `{family, arg}`; bare names fall through to tool/mcp. */
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
    return { family: "mcp", arg: trimmed, source: trimmed };
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
export const requestPath = (request: ApprovalRequest): string | null =>
  inputString(request.input, "path", "file_path", "filePath", "file");

/** The command a command-kind request is about, or null. */
const requestCommand = (request: ApprovalRequest): string | null =>
  inputString(request.input, "command", "cmd");

/** The URL or query a web-kind request is about, or null. */
const requestUrl = (request: ApprovalRequest): string | null =>
  inputString(request.input, "url", "query");

/**
 * Whether a parsed pattern matches the request. An unmatched request kind is
 * simply false — a `Shell(...)` rule says nothing about a file write.
 */
export const matchPattern = (pattern: ParsedPattern, request: ApprovalRequest): boolean => {
  switch (pattern.family) {
    case "shell": {
      if (request.kind !== "command" || pattern.arg === null) {
        return false;
      }
      const command = requestCommand(request);
      return command !== null && globToRegExp(pattern.arg).test(command);
    }
    case "edit":
    case "write": {
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
    case "webfetch": {
      if (request.kind !== "web" || pattern.arg === null) {
        return false;
      }
      const url = requestUrl(request);
      return url !== null && globToRegExp(pattern.arg).test(url);
    }
    case "websearch": {
      if (request.kind !== "web" || pattern.arg === null) {
        return false;
      }
      const query = requestUrl(request);
      return query !== null && globToRegExp(pattern.arg).test(query);
    }
    case "mcp":
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
export const patternMatches = (source: string, request: ApprovalRequest): boolean => {
  const parsed = parsePattern(source);
  return parsed !== null && matchPattern(parsed, request);
};
