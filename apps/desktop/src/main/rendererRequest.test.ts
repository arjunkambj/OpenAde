import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveRendererRequest } from "./rendererRequest";

const root = mkdtempSync(join(tmpdir(), "openade-renderer-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<!doctype html>", "utf8");
writeFileSync(join(root, "assets", "main.js"), "export {};", "utf8");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const resolve = (pathname: string, accept: string | null = null) =>
  resolveRendererRequest(root, pathname, accept);

describe("resolveRendererRequest", () => {
  it("serves a real file", () => {
    expect(resolve("/assets/main.js")).toEqual({
      kind: "file",
      path: join(root, "assets", "main.js"),
    });
    expect(resolve("/index.html")).toEqual({ kind: "file", path: join(root, "index.html") });
  });

  it("serves the shell for router paths", () => {
    const shell = { kind: "shell", path: join(root, "index.html") };
    expect(resolve("/")).toEqual(shell);
    expect(resolve("/threads/01a0b0cb")).toEqual(shell);
    expect(resolve("/settings/connectors")).toEqual(shell);
  });

  it("404s a missing asset instead of answering with the shell", () => {
    expect(resolve("/assets/typo.js")).toEqual({ kind: "notFound" });
    expect(resolve("/favicon.ico")).toEqual({ kind: "notFound" });
  });

  it("still serves the shell for a navigation that happens to look like a file", () => {
    expect(resolve("/threads/report.txt", "text/html,application/xhtml+xml")).toEqual({
      kind: "shell",
      path: join(root, "index.html"),
    });
  });

  it("refuses a path that climbs out of the renderer root", () => {
    expect(resolve("/%2e%2e/%2e%2e/etc/passwd")).toEqual({ kind: "notFound" });
    expect(resolve("/..%2f..%2fsecret")).toEqual({ kind: "notFound" });
  });

  it("refuses a malformed percent-encoding", () => {
    expect(resolve("/%E0%A4%A")).toEqual({ kind: "notFound" });
  });
});
