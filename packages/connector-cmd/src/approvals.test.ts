import { patternMatches } from "@poseidon/shared/permissionPattern";
import { describe, expect, it } from "vitest";

import { approvalKindFor, mcpToolFor, patternSuggestionFor } from "./approvals";

describe("patternSuggestionFor", () => {
  it("suggests Shell(<first-word> *) for shell commands", () => {
    expect(patternSuggestionFor("shell_command", { command: "rm -rf build" })).toBe("Shell(rm *)");
    expect(patternSuggestionFor("shell_command", { command: "pnpm run test" })).toBe(
      "Shell(pnpm *)",
    );
    // No usable command falls back to any shell call.
    expect(patternSuggestionFor("shell_command", { command: "" })).toBe("Shell(*)");
    expect(patternSuggestionFor("shell_command", {})).toBe("Shell(*)");
  });

  it("suggests Edit(<path>) for edits and writes, Read(<path>) for reads", () => {
    expect(patternSuggestionFor("edit_file", { file_path: "/src/app.ts" })).toBe(
      "Edit(/src/app.ts)",
    );
    expect(patternSuggestionFor("write_file", { path: "out/x.txt" })).toBe("Edit(out/x.txt)");
    expect(patternSuggestionFor("read_file", { file_path: "/etc/hosts" })).toBe("Read(/etc/hosts)");
    expect(patternSuggestionFor("read_directory", { path: "/src" })).toBe("Read(/src)");
    // Path-less inputs degrade to the tool family, not a broken pattern.
    expect(patternSuggestionFor("edit_file", {})).toBe("Edit(*)");
    expect(patternSuggestionFor("write_file", {})).toBe("Edit(*)");
  });

  it("suggests Mcp(<server>.<tool>) for mcp tools", () => {
    expect(patternSuggestionFor("mcp__poseidon__get_thread", { id: "t" })).toBe(
      "Mcp(poseidon.get_thread)",
    );
    expect(patternSuggestionFor("mcp__github__create_issue", {})).toBe("Mcp(github.create_issue)");
  });

  it("suggests Fetch(...) for web fetches and searches", () => {
    expect(patternSuggestionFor("web_fetch", { url: "https://docs.rs/x" })).toBe(
      "Fetch(https://docs.rs/x)",
    );
    expect(patternSuggestionFor("web_search", { query: "effect schema" })).toBe(
      "Fetch(effect schema)",
    );
    expect(patternSuggestionFor("web_fetch", {})).toBe("Fetch(*)");
  });

  it("falls back to the bare tool name for anything else", () => {
    expect(patternSuggestionFor("agent", { prompt: "go" })).toBe("agent");
    expect(patternSuggestionFor("todo_write", {})).toBe("todo_write");
    expect(patternSuggestionFor("glob", { pattern: "*.ts" })).toBe("glob");
  });

  it("suggests a pattern that matches the call it was made for", () => {
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ["shell_command", { command: "git status --short" }],
      ["edit_file", { file_path: "/src/app.ts" }],
      ["write_file", { path: "/tmp/out.txt" }],
      ["read_file", { file_path: "/etc/hosts" }],
      ["web_fetch", { url: "https://docs.rs/x" }],
      ["web_search", { query: "effect schema" }],
      ["mcp__github__create_issue", { title: "x" }],
      ["todo_write", {}],
    ];
    for (const [toolName, input] of calls) {
      const mcpTool = mcpToolFor(toolName);
      const request = {
        kind: approvalKindFor(toolName),
        toolName,
        input,
        ...(mcpTool === undefined ? {} : { mcpTool }),
      };
      expect(patternMatches(patternSuggestionFor(toolName, input), request), toolName).toBe(true);
    }
  });
});

describe("mcpToolFor", () => {
  it("splits Command Code's mcp__server__tool names", () => {
    expect(mcpToolFor("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
    // The server is the first segment; the tool keeps any further `__`.
    expect(mcpToolFor("mcp__a__b__c")).toEqual({ server: "a", tool: "b__c" });
  });

  it("names nothing for a tool that is not an MCP call", () => {
    expect(mcpToolFor("shell_command")).toBeUndefined();
    expect(mcpToolFor("mcp__only")).toBeUndefined();
  });
});
