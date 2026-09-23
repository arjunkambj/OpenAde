/**
 * Command Code's tool vocabulary, mapped onto OpenAde's approval model: which
 * kind of permission a tool call asks for, the MCP server and tool it names,
 * and the pattern its "allow always" button starts from — in OpenAde's own
 * pattern vocabulary (`@OpenAde/shared/permissionPattern`), not the CLI's
 * (docs/command-code-connector.md, "The tool vocabulary").
 */

import type { ApprovalKind } from "@OpenAde/contracts/enums";
import type { McpToolRef } from "@OpenAde/contracts/runtime";

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
 * The server and tool of an MCP call. Command Code names them
 * `mcp__<server>__<tool>`; the server is the first segment, and a tool name
 * may itself contain `__`.
 */
export const mcpToolFor = (toolName: string): McpToolRef | undefined => {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match === null ? undefined : { server: match[1]!, tool: match[2]! };
};

/**
 * The editable pattern the approval card's "allow always" starts from:
 * `Shell(<first-word> *)`, `Edit(<path>)` for both edits and writes,
 * `Read(<path>)`, `Fetch(<url or query>)`, `Mcp(<server>.<tool>)` — or the
 * bare tool name when nothing narrower applies.
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
  if (toolName === "edit_file" || toolName === "write_file") {
    return `Edit(${path ?? "*"})`;
  }
  if (toolName === "read_file" || toolName === "read_directory") {
    return `Read(${path ?? "*"})`;
  }
  if (toolName === "web_fetch") {
    return `Fetch(${field("url") ?? "*"})`;
  }
  if (toolName === "web_search") {
    return `Fetch(${field("query") ?? "*"})`;
  }
  const mcp = mcpToolFor(toolName);
  if (mcp !== undefined) {
    return `Mcp(${mcp.server}.${mcp.tool})`;
  }
  // Anything else (agent, todo_write, glob/grep without a path…) allows
  // always by tool name.
  return toolName;
};
