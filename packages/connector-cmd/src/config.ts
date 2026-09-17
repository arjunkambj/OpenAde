/**
 * The Command Code config OpenAde owns while a session is running.
 *
 * Two files, and both are put back the way they were when the session closes:
 *
 * - `<root>/.commandcode/settings.local.json` gets our PreToolUse hook block:
 *   `{ "matcher": ".*", "hooks": [{ "type": "command", "command": <hookPath>,
 *   "timeout": 590 }] }`. The merge preserves every other key and every other
 *   hook entry. Ownership is decided per *hook command*, not per entry, so a
 *   user hook sharing an entry with ours survives the removal.
 * - `~/.commandcode/projects/<slug>/mcp.json` — the local scope of spec 5.3,
 *   which is what spec section 8 step 2 names — gets an `openade` server entry
 *   whose bearer stays a `${OPENADE_MCP_TOKEN}` placeholder, since the harness
 *   resolves env references at launch (spec 5.6) and the per-session token must
 *   never touch disk. Writing it there rather than into `<root>/.mcp.json`
 *   keeps a loopback URL out of the user's git repo.
 *
 * Teardown is conditional twice over. Each install returns the hash of the
 * exact bytes it wrote, and the matching uninstall reverts only while the file
 * on disk still hashes to that — a file the user (or `cmd` itself) has since
 * edited is left alone. And a per-path retain count keeps the first session to
 * close from pulling the hook out from under a second session running in the
 * same project.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { hookScriptPath } from "./hookScript";

/** How long the harness lets our hook block on an answer (seconds; cap is 600). */
export const HOOK_TIMEOUT_SECONDS = 590;

/** Our MCP server name inside `mcp.json` — also the ownership marker. */
export const OPENADE_MCP_NAME = "openade";

type JsonObject = Record<string, unknown>;

/**
 * What one install wrote, and what its teardown needs to know: the file, the
 * hash of the bytes we left there, and whether the file existed at all before
 * (if not, teardown deletes it rather than leave an empty husk behind).
 */
export interface InstalledFile {
  readonly path: string;
  readonly hash: string;
  readonly created: boolean;
}

/**
 * What a read of one of these files found. The third state is the one the
 * installs turn on: a file that exists but is not strict JSON — a comment, a
 * trailing comma, an array — is a file we cannot merge into, and merging onto
 * the `{}` a failed parse would otherwise yield replaces everything in it.
 */
type JsonState =
  | { readonly kind: "absent" }
  | { readonly kind: "object"; readonly value: JsonObject }
  | { readonly kind: "unreadable" };

const readJsonState = (path: string): JsonState => {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  // An empty file has nothing in it to lose, so it merges like an absent one.
  if (raw.trim() === "") {
    return { kind: "object", value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { kind: "object", value: parsed as JsonObject }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
};

/**
 * The object the file holds, or `{}` when it is absent or unreadable. Only the
 * removal paths use this: they either write nothing (nothing of ours is in a
 * file we cannot read) or are hash-guarded against the bytes we wrote.
 */
const readJsonObject = (path: string): JsonObject => {
  const state = readJsonState(path);
  return state.kind === "object" ? state.value : {};
};

const hashOf = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/** The hash of the file as it is now, or null when it is unreadable/absent. */
const currentHash = (path: string): string | null => {
  try {
    return hashOf(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Writes atomically and returns the hash of the bytes that landed. */
const writeJsonObject = (path: string, value: JsonObject): string => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  // temp file + rename: a crash mid-write must not leave a truncated
  // settings.local.json or mcp.json behind.
  const tmp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(tmp, content, "utf8");
  NodeFS.renameSync(tmp, path);
  return hashOf(content);
};

const settingsLocalPath = (projectRoot: string): string =>
  NodePath.join(projectRoot, ".commandcode", "settings.local.json");

/** The transcript slug of spec 5.3: cwd lowercased, `/` → `-`, leading `-` dropped. */
const slugFor = (cwd: string): string => {
  const slug = cwd.toLowerCase().replaceAll("/", "-");
  return slug.startsWith("-") ? slug.slice(1) : slug;
};

/**
 * `~/.commandcode/projects/<slug>/mcp.json` — the project-local MCP scope.
 * `home` overrides the home directory the same way the transcript reader's
 * does, so a session with an `extraEnv.HOME` writes where its child reads.
 */
const mcpPath = (projectRoot: string, home?: string): string =>
  NodePath.join(
    home ?? NodeOS.homedir(),
    ".commandcode",
    "projects",
    slugFor(projectRoot),
    "mcp.json",
  );

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

/** True when one hook *command* inside an entry is our generated script. */
const isOurCommand = (hook: unknown, hookPath: string): boolean => {
  const command = (hook as HookCommand | undefined)?.command;
  return (
    typeof command === "string" &&
    (command === hookPath ||
      command.endsWith(`/${HOOK_SCRIPT_BASENAME}`) ||
      command === HOOK_SCRIPT_BASENAME)
  );
};

/**
 * One PreToolUse entry with our hook commands stripped out — `null` when
 * nothing but ours was in it. Filtering here rather than at the entry level is
 * what keeps a user hook that shares a matcher entry with ours.
 */
const withoutOurCommands = (entry: unknown, hookPath: string): unknown | null => {
  const hooks = (entry as HookEntry | undefined)?.hooks;
  if (!Array.isArray(hooks)) {
    return entry;
  }
  const kept = hooks.filter((hook) => !isOurCommand(hook, hookPath));
  if (kept.length === hooks.length) {
    return entry;
  }
  return kept.length === 0 ? null : { ...(entry as JsonObject), hooks: kept };
};

const stripOurs = (entries: ReadonlyArray<unknown>, hookPath: string): Array<unknown> =>
  entries.flatMap((entry) => {
    const next = withoutOurCommands(entry, hookPath);
    return next === null ? [] : [next];
  });

// ".*" is the matcher the spec documents (section 8): a matcher is a regex
// over the tool name, and an empty one risks matching nothing — which would
// leave every tool ungated under --yolo.
const ourEntry = (hookPath: string): JsonObject => ({
  matcher: ".*",
  hooks: [{ type: "command", command: hookPath, timeout: HOOK_TIMEOUT_SECONDS }],
});

// ── retain counts ──────────────────────────────────────────────

/**
 * Open installs per file, for this server process. Two threads on the same
 * project install the identical block; the first to close must not remove it
 * while the second is still running turns through it.
 */
const retained = new Map<string, { count: number; readonly created: boolean }>();

/**
 * Takes a hold and answers whether the *first* holder created the file — a
 * second session installing over an existing block did not create anything,
 * but the teardown that runs last still owes the deletion the first one earned.
 */
const retain = (path: string, created: boolean): boolean => {
  const entry = retained.get(path);
  if (entry === undefined) {
    retained.set(path, { count: 1, created });
    return created;
  }
  entry.count += 1;
  return entry.created;
};

/** Drops one hold. True when it was the last — the file may be reverted now. */
const release = (path: string): boolean => {
  const entry = retained.get(path);
  if (entry === undefined || entry.count <= 1) {
    retained.delete(path);
    return true;
  }
  entry.count -= 1;
  return false;
};

/**
 * Reverts a file we wrote: skips when someone else still holds it or when the
 * bytes have changed since, deletes it when we created it and `next` is empty,
 * and otherwise writes `next`.
 */
const revert = (installed: InstalledFile, next: JsonObject): void => {
  if (!release(installed.path)) {
    return;
  }
  if (currentHash(installed.path) !== installed.hash) {
    // Edited since we wrote it — the newer content is not ours to undo.
    return;
  }
  if (installed.created && Object.keys(next).length === 0) {
    try {
      NodeFS.rmSync(installed.path);
    } catch {
      // Already gone.
    }
    return;
  }
  writeJsonObject(installed.path, next);
};

// ── the PreToolUse hook block ──────────────────────────────────

/**
 * Ensures `settings.local.json` contains our PreToolUse hook block. Idempotent:
 * our previous commands are replaced, the user's are preserved.
 *
 * `null` means the file was left untouched because it does not parse — the
 * caller warns and runs without the hook rather than overwrite a settings file
 * whose permissions lists we cannot read back.
 */
export const installProjectHooks = (
  projectRoot: string,
  hookPath: string = hookScriptPath(),
): Effect.Effect<InstalledFile | null> =>
  Effect.sync(() => {
    const path = settingsLocalPath(projectRoot);
    const state = readJsonState(path);
    if (state.kind === "unreadable") {
      return null;
    }
    const fresh = state.kind === "absent";
    const settings = state.kind === "object" ? state.value : {};
    const hooks = { ...(settings.hooks as JsonObject | undefined) };
    const existing = hooks.PreToolUse;
    const kept = stripOurs(Array.isArray(existing) ? existing : [], hookPath);
    hooks.PreToolUse = [...kept, ourEntry(hookPath)];
    const hash = writeJsonObject(path, { ...settings, hooks });
    return { path, hash, created: retain(path, fresh) };
  });

/**
 * Removes the PreToolUse hook commands that point at our script. With
 * `installed` it reverts only while the file is still byte-for-byte what that
 * install wrote, and only once the last session holding it has closed.
 */
export const uninstallProjectHooks = (
  projectRoot: string,
  hookPath: string = hookScriptPath(),
  installed?: InstalledFile,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const path = installed?.path ?? settingsLocalPath(projectRoot);
    const compute = (): JsonObject => {
      const settings = readJsonObject(path);
      const hooks = settings.hooks as JsonObject | undefined;
      const existing = hooks?.PreToolUse;
      if (!Array.isArray(existing)) {
        return settings;
      }
      const kept = stripOurs(existing, hookPath);
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
      return next;
    };
    if (installed !== undefined) {
      revert(installed, compute());
      return;
    }
    const existing = (readJsonObject(path).hooks as JsonObject | undefined)?.PreToolUse;
    if (Array.isArray(existing)) {
      writeJsonObject(path, compute());
    }
  });

// ── the MCP server entry ───────────────────────────────────────

/**
 * Upserts the `openade` server in the project's local `mcp.json`, preserving
 * every other server and every other key. The bearer is written as the
 * `${OPENADE_MCP_TOKEN}` env reference the harness resolves at launch.
 *
 * `null` when the file does not parse — the user's other servers are not ours
 * to drop, so nothing is written and the caller warns instead.
 */
export const upsertMcpEntry = (
  projectRoot: string,
  endpoint: { readonly url: string },
  home?: string,
): Effect.Effect<InstalledFile | null> =>
  Effect.sync(() => {
    const path = mcpPath(projectRoot, home);
    const state = readJsonState(path);
    if (state.kind === "unreadable") {
      return null;
    }
    const fresh = state.kind === "absent";
    const config = state.kind === "object" ? state.value : {};
    const servers = { ...(config.mcpServers as JsonObject | undefined) };
    servers[OPENADE_MCP_NAME] = {
      transport: "http",
      enabled: true,
      url: endpoint.url,
      headers: { Authorization: "Bearer ${OPENADE_MCP_TOKEN}" },
    };
    const hash = writeJsonObject(path, { ...config, mcpServers: servers });
    return { path, hash, created: retain(path, fresh) };
  });

/**
 * Removes the `openade` server entry. With `installed` it reverts only an
 * untouched file, and only once the last session holding it has closed.
 */
export const removeMcpEntry = (
  projectRoot: string,
  home?: string,
  installed?: InstalledFile,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const path = installed?.path ?? mcpPath(projectRoot, home);
    const compute = (): JsonObject => {
      const config = readJsonObject(path);
      const servers = config.mcpServers as JsonObject | undefined;
      if (servers === undefined || !(OPENADE_MCP_NAME in servers)) {
        return config;
      }
      const next = { ...servers };
      delete next[OPENADE_MCP_NAME];
      // An mcpServers map holding nothing but ours goes with it, so a file we
      // created can be deleted outright instead of left as `{"mcpServers":{}}`.
      return Object.keys(next).length === 0
        ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== "mcpServers"))
        : { ...config, mcpServers: next };
    };
    if (installed !== undefined) {
      revert(installed, compute());
      return;
    }
    const servers = readJsonObject(path).mcpServers as JsonObject | undefined;
    if (servers !== undefined && OPENADE_MCP_NAME in servers) {
      writeJsonObject(path, compute());
    }
  });
