import { describe, expect, it } from "vitest";

import {
  parsePattern,
  patternMatches,
  requestPath,
  type PatternSubject,
} from "./permissionPattern";

const request = (
  kind: string,
  input: unknown,
  toolName = "tool",
  mcpTool?: PatternSubject["mcpTool"],
): PatternSubject => ({
  kind,
  toolName,
  input,
  ...(mcpTool === undefined ? {} : { mcpTool }),
});

describe("parsePattern", () => {
  it("parses Poseidon's call forms", () => {
    expect(parsePattern("Read(/docs/**)")).toMatchObject({ family: "read", arg: "/docs/**" });
    expect(parsePattern("Fetch(https://*)")).toMatchObject({ family: "fetch", arg: "https://*" });
    expect(parsePattern("Mcp(github.*)")).toMatchObject({ family: "mcp", arg: "github.*" });
  });

  it("parses the stored aliases into the canonical families", () => {
    expect(parsePattern("Write(/tmp/**)")).toMatchObject({ family: "edit", arg: "/tmp/**" });
    expect(parsePattern("WebFetch(https://x)")).toMatchObject({ family: "fetch" });
    expect(parsePattern("WebSearch(effect)")).toMatchObject({ family: "fetch" });
  });

  it("parses the call form, mcp literal and bare tool names", () => {
    expect(parsePattern("Shell(npm run *)")).toMatchObject({
      family: "shell",
      arg: "npm run *",
    });
    expect(parsePattern("Edit(/src/**)")).toMatchObject({ family: "edit", arg: "/src/**" });
    expect(parsePattern("mcp__github__create_issue")).toMatchObject({
      family: "mcp-name",
      arg: "mcp__github__create_issue",
    });
    expect(parsePattern("shell_command")).toMatchObject({ family: "tool", arg: "shell_command" });
    expect(parsePattern("Shell(unclosed")).toMatchObject({ family: "tool" });
    expect(parsePattern("Unknown(x)")).toBeNull();
    expect(parsePattern("  ")).toBeNull();
  });
});

describe("patternMatches", () => {
  it("matches Shell patterns against commands", () => {
    const run = (pattern: string, command: string) =>
      patternMatches(pattern, request("command", { command }, "shell_command"));
    expect(run("Shell(npm run *)", "npm run build")).toBe(true);
    expect(run("Shell(npm run *)", "npm install")).toBe(false);
    expect(run("Shell(git status)", "git status")).toBe(true);
    expect(run("Shell(git status)", "git status --short")).toBe(false);
    expect(run("Shell(rm -rf *)", "rm -rf /")).toBe(true);
  });

  it("matches Edit/Write patterns against write paths", () => {
    const edit = (pattern: string, path: string) =>
      patternMatches(pattern, request("file_write", { path }, "file_write"));
    expect(edit("Edit(/src/**)", "/src/components/app.tsx")).toBe(true);
    expect(edit("Edit(/src/**)", "/README.md")).toBe(false);
    expect(edit("Edit(/src/*)", "/src/deep/nested.ts")).toBe(false);
    expect(edit("Write(/tmp/**)", "/tmp/out.txt")).toBe(true);
    // Write patterns do not reach reads, and vice versa.
    expect(patternMatches("Write(/src/**)", request("file_read", { path: "/src/x" }))).toBe(false);
    expect(patternMatches("Read(/src/**)", request("file_read", { path: "/src/a/b" }))).toBe(true);
  });

  it("matches mcp__ patterns and bare tool names against toolName", () => {
    const mcp = request("mcp_tool", {}, "mcp__github__create_issue");
    expect(patternMatches("mcp__github__create_issue", mcp)).toBe(true);
    expect(patternMatches("mcp__github__*", mcp)).toBe(true);
    expect(patternMatches("mcp__other__*", mcp)).toBe(false);
    expect(patternMatches("shell_command", request("command", {}, "shell_command"))).toBe(true);
  });

  it("matches WebFetch/WebSearch against urls and queries", () => {
    const web = (input: unknown) => request("web", input, "web_fetch");
    expect(
      patternMatches("WebFetch(https://*.example.com/*)", web({ url: "https://a.example.com/x" })),
    ).toBe(true);
    expect(patternMatches("WebFetch(https://a.test/*)", web({ url: "https://b.test/x" }))).toBe(
      false,
    );
    expect(
      patternMatches("WebSearch(*security*)", web({ query: "latest security advisories" })),
    ).toBe(true);
    // A web pattern says nothing about a command request.
    expect(patternMatches("WebFetch(*)", request("command", { command: "ls" }))).toBe(false);
  });

  it("matches Fetch against urls and queries", () => {
    const web = (input: unknown) => request("web", input, "fetch");
    expect(
      patternMatches("Fetch(https://*.example.com/*)", web({ url: "https://a.example.com/x" })),
    ).toBe(true);
    expect(patternMatches("Fetch(*security*)", web({ query: "security advisories" }))).toBe(true);
    expect(patternMatches("Fetch(https://a.test/*)", web({ url: "https://b.test/x" }))).toBe(false);
    expect(patternMatches("Fetch(*)", request("file_read", { path: "/x" }))).toBe(false);
  });

  it("matches Mcp(server.tool) against the request's mcpTool", () => {
    const ref = { server: "github", tool: "create_issue" };
    const mcp = request("mcp_tool", {}, "mcp__github__create_issue", ref);
    expect(patternMatches("Mcp(github.create_issue)", mcp)).toBe(true);
    expect(patternMatches("Mcp(github.*)", mcp)).toBe(true);
    expect(patternMatches("Mcp(*.create_*)", mcp)).toBe(true);
    expect(patternMatches("Mcp(other.*)", mcp)).toBe(false);
    // The dot is literal, not a regex wildcard.
    expect(patternMatches("Mcp(githubXcreate_issue)", mcp)).toBe(false);
    // A request whose connector named no MCP tool, or not an MCP request.
    expect(patternMatches("Mcp(*)", request("mcp_tool", {}, "mcp__github__create_issue"))).toBe(
      false,
    );
    expect(patternMatches("Mcp(*)", request("command", { command: "ls" }, "x", ref))).toBe(false);
  });

  it("keeps the legacy mcp__ literal matching the tool name as before", () => {
    const ref = { server: "github", tool: "create_issue" };
    const mcp = request("mcp_tool", {}, "mcp__github__create_issue", ref);
    expect(patternMatches("mcp__github__create_issue", mcp)).toBe(true);
    expect(patternMatches("mcp__github__*", mcp)).toBe(true);
    expect(patternMatches("mcp__other__*", mcp)).toBe(false);
    // Still only for MCP requests.
    expect(patternMatches("mcp__*", request("other", {}, "mcp__github__create_issue"))).toBe(false);
  });

  it("extracts the subject path across input key spellings", () => {
    expect(requestPath(request("file_read", { path: "/a" }))).toBe("/a");
    expect(requestPath(request("file_read", { file_path: "/b" }))).toBe("/b");
    expect(requestPath(request("file_read", { filePath: "/c" }))).toBe("/c");
    expect(requestPath(request("file_read", {}))).toBeNull();
  });

  it("treats unparseable patterns as matching nothing", () => {
    expect(patternMatches("Unknown(x)", request("command", { command: "x" }))).toBe(false);
    expect(patternMatches("", request("command", { command: "x" }))).toBe(false);
  });
});
