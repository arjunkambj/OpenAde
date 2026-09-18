/**
 * Command Code's tool vocabulary, as the approval card needs it: which kind of
 * permission a tool call asks for, and the pattern its "allow always" button
 * starts from (docs/command-code-connector.md, "The tool vocabulary").
 */

import type { ApprovalKind } from "@OpenAde/contracts/enums";

/** Which kind of permission a tool call asks for. */
export const approvalKindFor = (toolName: string): ApprovalKind => {
  if (toolName === "shell_command") return "command";
  if (toolName === "edit_file" || toolName === "write_file") return "file_write";
  if (toolName.startsWith("read_") || toolName === "glob" || toolName === "grep")
    return "file_read";
  if (toolName.startsWith("mcp__")) return "mcp_tool";
  if (toolName === "web_search" || toolName === "web_fetch") return "web";
  return "other";
};

/**
 * The editable pattern the approval card's "allow always" starts from, in
 * Command Code's syntax: `Shell(<first-word> *)`, `Edit(<path>)`,
 * `Write(<path>)`, `Read(<path>)`, `WebFetch(<url>)`, `WebSearch(<query>)`, a
 * literal `mcp__server__tool` — or the bare tool name when nothing narrower
 * applies.
 */
export const patternSuggestionFor = (toolName: string, input: unknown): string => {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const field = (...keys: ReadonlyArray<string>): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return undefined;
  };
  const path = field("file_path", "path", "filePath", "file");
  if (toolName === "shell_command") {
    const command = field("command", "cmd");
    const first = command === undefined ? undefined : command.split(/\s+/)[0];
    return first === undefined || first === "" ? "Shell(*)" : `Shell(${first} *)`;
  }
  if (toolName === "edit_file") {
    return `Edit(${path ?? "*"})`;
  }
  if (toolName === "write_file") {
    return `Write(${path ?? "*"})`;
  }
  if (toolName === "read_file" || toolName === "read_directory") {
    return `Read(${path ?? "*"})`;
  }
  if (toolName === "web_fetch") {
    return `WebFetch(${field("url") ?? "*"})`;
  }
  if (toolName === "web_search") {
    return `WebSearch(${field("query") ?? "*"})`;
  }
  // mcp__server__tool is already a literal pattern; anything else (agent,
  // todo_write, glob/grep without a path…) allows always by tool name.
  return toolName;
};
