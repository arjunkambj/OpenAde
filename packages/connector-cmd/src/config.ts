/**
 * The project-local Command Code config OpenAde owns.
 *
 * Two files, both inside the workspace the session runs in:
 *
 * - `<root>/.commandcode/settings.local.json` gets our PreToolUse hook block:
 *   `{ "matcher": ".*", "hooks": [{ "type": "command", "command": <hookPath>,
 *   "timeout": 590 }] }`. The merge preserves every other key and every other
 *   hook entry — ours is identified by its `command` pointing at the generated
 *   hook script, which is also what `uninstallProjectHooks` removes and nothing
 *   else.
 * - `<root>/.mcp.json` gets an `openade` server entry whose bearer stays a
 *   `${OPENADE_MCP_TOKEN}` placeholder — the harness resolves env references
 *   at launch (spec 5.6), so the per-session token never touches disk.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { hookScriptPath } from "./hookScript";

/** How long the harness lets our hook block on an answer (seconds; cap is 600). */
export const HOOK_TIMEOUT_SECONDS = 590;

/** Our MCP server name inside `.mcp.json` — also the ownership marker. */
export const OPENADE_MCP_NAME = "openade";

type JsonObject = Record<string, unknown>;

const readJsonObject = (path: string): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
};

const writeJsonObject = (path: string, value: JsonObject): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  // temp file + rename: a crash mid-write must not leave a truncated
  // settings.local.json or .mcp.json in the user's project.
  const tmp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  NodeFS.renameSync(tmp, path);
};

const settingsLocalPath = (projectRoot: string): string =>
  NodePath.join(projectRoot, ".commandcode", "settings.local.json");

const mcpPath = (projectRoot: string): string => NodePath.join(projectRoot, ".mcp.json");

interface HookEntry {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
}

interface HookCommand {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly timeout?: unknown;
}

const HOOK_SCRIPT_BASENAME = "cmd-hook.mjs";

/** True when a PreToolUse entry's command is our generated script. */
const isOurs = (entry: unknown, hookPath: string): boolean => {
  const hooks = (entry as HookEntry | undefined)?.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  return hooks.some((hook) => {
    const command = (hook as HookCommand | undefined)?.command;
    return (
      typeof command === "string" &&
      (command === hookPath ||
        command.endsWith(`/${HOOK_SCRIPT_BASENAME}`) ||
        command === HOOK_SCRIPT_BASENAME)
    );
  });
};

// ".*" is the matcher the spec documents (section 8): a matcher is a regex
// over the tool name, and an empty one risks matching nothing — which would
// leave every tool ungated under --yolo.
const ourEntry = (hookPath: string): JsonObject => ({
  matcher: ".*",
  hooks: [{ type: "command", command: hookPath, timeout: HOOK_TIMEOUT_SECONDS }],
});

/**
 * Ensures `settings.local.json` contains our PreToolUse hook block. Idempotent:
 * our previous entries are replaced, the user's entries are preserved.
 */
export const installProjectHooks = (
  projectRoot: string,
  hookPath: string = hookScriptPath(),
): Effect.Effect<string> =>
  Effect.sync(() => {
    const path = settingsLocalPath(projectRoot);
    const settings = readJsonObject(path);
    const hooks = { ...(settings.hooks as JsonObject | undefined) };
    const existing = hooks.PreToolUse;
    const kept = (Array.isArray(existing) ? existing : []).filter(
      (entry) => !isOurs(entry, hookPath),
    );
    hooks.PreToolUse = [...kept, ourEntry(hookPath)];
    writeJsonObject(path, { ...settings, hooks });
    return path;
  });

/** Removes only the PreToolUse entries that point at our hook script. */
export const uninstallProjectHooks = (
  projectRoot: string,
  hookPath: string = hookScriptPath(),
): Effect.Effect<void> =>
  Effect.sync(() => {
    const path = settingsLocalPath(projectRoot);
    const settings = readJsonObject(path);
    const hooks = settings.hooks as JsonObject | undefined;
    const existing = hooks?.PreToolUse;
    if (!Array.isArray(existing)) {
      return;
    }
    const kept = existing.filter((entry) => !isOurs(entry, hookPath));
    const nextHooks = { ...hooks };
    if (kept.length === 0) {
      delete nextHooks.PreToolUse;
    } else {
      nextHooks.PreToolUse = kept;
    }
    const next: JsonObject = { ...settings, hooks: nextHooks };
    if (Object.keys(nextHooks).length === 0) {
      delete next.hooks;
    }
    writeJsonObject(path, next);
  });

/**
 * Upserts the `openade` server in the project's `.mcp.json`, preserving every
 * other server and every other key. The bearer is written as the
 * `${OPENADE_MCP_TOKEN}` env reference the harness resolves at launch.
 */
export const upsertMcpEntry = (
  projectRoot: string,
  endpoint: { readonly url: string },
): Effect.Effect<string> =>
  Effect.sync(() => {
    const path = mcpPath(projectRoot);
    const config = readJsonObject(path);
    const servers = { ...(config.mcpServers as JsonObject | undefined) };
    servers[OPENADE_MCP_NAME] = {
      transport: "http",
      enabled: true,
      url: endpoint.url,
      headers: { Authorization: "Bearer ${OPENADE_MCP_TOKEN}" },
    };
    writeJsonObject(path, { ...config, mcpServers: servers });
    return path;
  });

/** Removes only the `openade` server entry. */
export const removeMcpEntry = (projectRoot: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const path = mcpPath(projectRoot);
    const config = readJsonObject(path);
    const servers = config.mcpServers as JsonObject | undefined;
    if (servers === undefined || !(OPENADE_MCP_NAME in servers)) {
      return;
    }
    const next = { ...servers };
    delete next[OPENADE_MCP_NAME];
    writeJsonObject(path, { ...config, mcpServers: next });
  });
