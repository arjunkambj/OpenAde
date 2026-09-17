/**
 * The project-local config OpenAde owns: the PreToolUse hook block in
 * `.commandcode/settings.local.json` and the `openade` entry in `.mcp.json`.
 * Both merge into files the user may already have, so the tests run against
 * real files in a temp project root — merge, idempotency and removal are the
 * whole contract.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import {
  installProjectHooks,
  OPENADE_MCP_NAME,
  removeMcpEntry,
  uninstallProjectHooks,
  upsertMcpEntry,
} from "./config";
import { ensureHookScript, hookScriptPath, hookScriptSource } from "./hookScript";

const tempDir = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-config-test-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;

const settingsLocal = (root: string): string =>
  NodePath.join(root, ".commandcode", "settings.local.json");

describe("installProjectHooks", () => {
  it.effect("writes the PreToolUse block into a fresh settings.local.json", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const path = yield* installProjectHooks(root, "/home/u/.openade/bin/cmd-hook.mjs");

      const settings = readJson(path);
      const hooks = settings.hooks as Record<string, unknown>;
      const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;
      expect(preToolUse).toHaveLength(1);
      expect(preToolUse[0]?.matcher).toBe(".*");
      const commands = preToolUse[0]?.hooks as Array<Record<string, unknown>>;
      expect(commands[0]).toEqual({
        type: "command",
        command: "/home/u/.openade/bin/cmd-hook.mjs",
        timeout: 590,
      });
    }),
  );

  it.effect("preserves other keys and other hook entries, and is idempotent", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          permissions: { defaultMode: "default", allow: ["Shell(git status:*)"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "shell",
                hooks: [{ type: "command", command: "/usr/bin/theirs", timeout: 30 }],
              },
            ],
            PostToolUse: [{ matcher: "", hooks: [] }],
          },
        }),
      );

      const path = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      let settings = readJson(path);
      let preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(2); // theirs, then ours
      expect((preToolUse[0] as Record<string, unknown>).matcher).toBe("shell");
      expect((settings.permissions as Record<string, unknown>).defaultMode).toBe("default");
      expect((settings.hooks as Record<string, unknown>).PostToolUse).toBeDefined();

      // Installing again replaces our entry rather than appending a second.
      yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      settings = readJson(path);
      preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(2);
    }),
  );

  it.effect("uninstall removes only our entries and cleans empty husks", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");

      let settings = readJson(settingsLocal(root));
      expect(settings.hooks).toBeUndefined();

      // A user entry next to ours survives; ours leaves.
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "", hooks: [{ type: "command", command: "/h/cmd-hook.mjs" }] },
              { matcher: "x", hooks: [{ type: "command", command: "/theirs" }] },
            ],
          },
        }),
      );
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");
      settings = readJson(settingsLocal(root));
      const preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(1);
      expect((preToolUse[0] as Record<string, unknown>).matcher).toBe("x");

      // Uninstall on a file without hooks is a no-op, not an error.
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");
    }),
  );
});

describe("mcp entry", () => {
  it.effect("upserts the openade server with the env-resolved bearer", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.writeFileSync(
        NodePath.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { transport: "stdio", command: "x" } } }),
      );

      const path = yield* upsertMcpEntry(root, { url: "http://127.0.0.1:4321/mcp" });
      const config = readJson(path);
      const servers = config.mcpServers as Record<string, unknown>;
      expect(servers.other).toEqual({ transport: "stdio", command: "x" });
      expect(servers[OPENADE_MCP_NAME]).toEqual({
        transport: "http",
        enabled: true,
        url: "http://127.0.0.1:4321/mcp",
        headers: { Authorization: "Bearer ${OPENADE_MCP_TOKEN}" },
      });

      // A second upsert moves the url without duplicating the server.
      yield* upsertMcpEntry(root, { url: "http://127.0.0.1:9999/mcp" });
      const again = readJson(path).mcpServers as Record<string, { url: string }>;
      expect(Object.keys(again)).toHaveLength(2);
      expect(again[OPENADE_MCP_NAME]?.url).toBe("http://127.0.0.1:9999/mcp");

      yield* removeMcpEntry(root);
      const after = readJson(path).mcpServers as Record<string, unknown>;
      expect(after[OPENADE_MCP_NAME]).toBeUndefined();
      expect(after.other).toBeDefined();

      // Removing when never installed is a no-op.
      yield* removeMcpEntry(root);
    }),
  );
});

describe("ensureHookScript", () => {
  it.effect("writes the script once, executable, and rewrites only on drift", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const env = { OPENADE_HOME: home };

      const path = yield* ensureHookScript(env);
      expect(path).toBe(hookScriptPath(env));
      expect(path.endsWith(`bin${NodePath.sep}cmd-hook.mjs`)).toBe(true);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(hookScriptSource());
      // 0700 — the shell executes it directly.
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o700);

      // Same content → no rewrite. Proof: make the file read-only; a rewrite
      // would fail the effect, a stat-only pass restores the exec bit.
      NodeFS.chmodSync(path, 0o400);
      yield* ensureHookScript(env);
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o700);

      NodeFS.writeFileSync(path, "// tampered\n");
      yield* ensureHookScript(env);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(hookScriptSource());
    }),
  );
});
