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
      const { path, created } = yield* installProjectHooks(
        root,
        "/home/u/.openade/bin/cmd-hook.mjs",
      );
      expect(created).toBe(true);

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

      // The write is temp-file + rename: no scratch file survives.
      expect(
        NodeFS.readdirSync(NodePath.dirname(path)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
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

      const { path, created } = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      expect(created).toBe(false);
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

  it.effect("a user hook sharing our entry survives install and uninstall", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [
                  { type: "command", command: "/usr/bin/theirs" },
                  { type: "command", command: "/h/cmd-hook.mjs" },
                ],
              },
            ],
          },
        }),
      );

      const installed = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      const entries = (readJson(installed.path).hooks as Record<string, unknown>)
        .PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
      // Their command is kept where it was; ours moved into its own entry.
      expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual(["/usr/bin/theirs"]);
      expect(entries[1]?.hooks.map((hook) => hook.command)).toEqual(["/h/cmd-hook.mjs"]);

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      const after = (readJson(installed.path).hooks as Record<string, unknown>)
        .PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
      expect(after).toHaveLength(1);
      expect(after[0]?.hooks.map((hook) => hook.command)).toEqual(["/usr/bin/theirs"]);
    }),
  );

  it.effect("a hash-guarded uninstall deletes the file it created, or stands down", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const installed = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      expect(NodeFS.existsSync(installed.path)).toBe(true);
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      // Nothing of ours was left to keep, and the file was ours to begin with.
      expect(NodeFS.existsSync(installed.path)).toBe(false);

      // Edited since we wrote it → the newer content stays untouched.
      const second = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      NodeFS.writeFileSync(second.path, JSON.stringify({ permissions: { deny: ["Shell(*)"] } }));
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", second);
      expect(readJson(second.path).permissions).toEqual({ deny: ["Shell(*)"] });
    }),
  );

  it.effect("a second session's hold keeps the block in place until it closes too", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const first = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      const second = yield* installProjectHooks(root, "/h/cmd-hook.mjs");

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", first);
      expect(readJson(first.path).hooks).toBeDefined();

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", second);
      expect(NodeFS.existsSync(second.path)).toBe(false);
    }),
  );
});

describe("mcp entry", () => {
  it.effect("upserts the openade server into the project-local mcp.json", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const root = yield* tempDir();
      // Spec 5.3 / section 8: the local scope is ~/.commandcode/projects/<slug>,
      // not a .mcp.json inside the user's repo.
      const slug = root.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
      const expected = NodePath.join(home, ".commandcode", "projects", slug, "mcp.json");
      NodeFS.mkdirSync(NodePath.dirname(expected), { recursive: true });
      NodeFS.writeFileSync(
        expected,
        JSON.stringify({ mcpServers: { other: { transport: "stdio", command: "x" } } }),
      );

      const { path } = yield* upsertMcpEntry(root, { url: "http://127.0.0.1:4321/mcp" }, home);
      expect(path).toBe(expected);
      expect(NodeFS.existsSync(NodePath.join(root, ".mcp.json"))).toBe(false);
      const servers = readJson(path).mcpServers as Record<string, unknown>;
      expect(servers.other).toEqual({ transport: "stdio", command: "x" });
      expect(servers[OPENADE_MCP_NAME]).toEqual({
        transport: "http",
        enabled: true,
        url: "http://127.0.0.1:4321/mcp",
        headers: { Authorization: "Bearer ${OPENADE_MCP_TOKEN}" },
      });

      // A second upsert moves the url without duplicating the server.
      yield* upsertMcpEntry(root, { url: "http://127.0.0.1:9999/mcp" }, home);
      const again = readJson(path).mcpServers as Record<string, { url: string }>;
      expect(Object.keys(again)).toHaveLength(2);
      expect(again[OPENADE_MCP_NAME]?.url).toBe("http://127.0.0.1:9999/mcp");

      yield* removeMcpEntry(root, home);
      const after = readJson(path).mcpServers as Record<string, unknown>;
      expect(after[OPENADE_MCP_NAME]).toBeUndefined();
      expect(after.other).toBeDefined();

      // Removing when never installed is a no-op.
      yield* removeMcpEntry(root, home);
    }),
  );

  it.effect("a guarded remove deletes the mcp.json it created", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const root = yield* tempDir();
      const installed = yield* upsertMcpEntry(root, { url: "http://127.0.0.1:1/mcp" }, home);
      expect(NodeFS.existsSync(installed.path)).toBe(true);

      yield* removeMcpEntry(root, home, installed);
      expect(NodeFS.existsSync(installed.path)).toBe(false);
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

      // Temp-file + rename leaves no scratch files behind.
      expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(["cmd-hook.mjs"]);
    }),
  );
});
