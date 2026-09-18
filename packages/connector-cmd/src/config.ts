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
 * - the local MCP scope (`~/.commandcode/projects/<slug>/mcp.json`)
 *   gets an `openade` server entry whose bearer stays a
 *   `${OPENADE_MCP_TOKEN}` placeholder, since the harness resolves env
 *   references at launch and the per-session token must never touch
 *   disk. That file lives under a slug of the workspace path that only the CLI
 *   knows how to spell, so the CLI writes it — see `upsertMcpEntry`.
 *
 * Teardown of the hook block is conditional twice over. The install returns the
 * hash of the exact bytes it wrote, and the uninstall reverts only while the
 * file on disk still hashes to that — a file the user (or `cmd` itself) has
 * since edited is left alone. And a per-path retain count keeps the first
 * session to close from pulling the hook out from under a second session
 * running in the same project.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
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

/** Characters a POSIX shell passes through untouched. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A hook command the shell will read as one word.
 *
 * The harness runs a hook's `command` through `/bin/bash` — `runSyncHook` in
 * the 1.56.0 bundle calls `shell.run({command, shell: hookShell(runtime)})`,
 * and `hookShell` answers `/bin/bash` off Windows. So on a macOS account whose
 * home is `/Users/First Last`, the unquoted path split into two words, the
 * hook never ran, it produced no decision, and under `--yolo` every
 * shell_command and file write in that session ran without ever raising a
 * card: the gate's failure mode is to open, silently.
 *
 * A path that needs no quoting is written exactly as before, so no existing
 * settings file changes and nothing has to be re-matched by hand.
 */
export const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** The path inside a hook command, however it was quoted when written. */
const unquote = (command: string): string => {
  const trimmed = command.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  return trimmed;
};

/** True when one hook *command* inside an entry is our generated script. */
const isOurCommand = (hook: unknown, hookPath: string): boolean => {
  const raw = (hook as HookCommand | undefined)?.command;
  if (typeof raw !== "string") {
    return false;
  }
  const command = unquote(raw);
  return (
    command === hookPath ||
    command === unquote(hookPath) ||
    command.endsWith(`/${HOOK_SCRIPT_BASENAME}`) ||
    command === HOOK_SCRIPT_BASENAME
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
  hooks: [{ type: "command", command: shellQuote(hookPath), timeout: HOOK_TIMEOUT_SECONDS }],
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

/** Takes a hold on something that has no "created" question to answer. */
const retainKey = (key: string): void => {
  const entry = retained.get(key);
  if (entry === undefined) {
    retained.set(key, { count: 1, created: false });
    return;
  }
  entry.count += 1;
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
 * What one `cmd mcp` call needs: the binary the session is already spawning,
 * the workspace it runs in, and that session's environment.
 */
/**
 * The retain key for a project's MCP entry. The file it stands for lives under
 * `~/.commandcode/projects/<slug>/`, whose spelling only the CLI knows — so
 * the workspace root, resolved through symlinks, is the handle. Prefixed so it
 * cannot collide with the settings files held by path.
 */
const mcpKey = (projectRoot: string): string => {
  let resolved = projectRoot;
  try {
    resolved = NodeFS.realpathSync(projectRoot);
  } catch {
    // A workspace that has gone away keys on the path we were given.
  }
  return `mcp:${resolved}`;
};

export interface McpRegistration {
  readonly binaryPath: string;
  /** The npx fallback's package spec, prepended to every `cmd mcp` call. */
  readonly prefixArgs?: ReadonlyArray<string>;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  /** How long the call gets. Defaults to `MCP_TIMEOUT_MS`; a test shortens it. */
  readonly timeoutMs?: number;
}

/**
 * How long a `cmd mcp` call gets before it is killed and reported as a refusal.
 *
 * It used to get forever, and synchronously: `spawnSync` blocks the Node event
 * loop, not just one fiber. This runs on the first turn of every thread
 * (`upsertMcpEntry`) and on every session close including the manager's
 * shutdown finalizer, so for the whole duration of the child the WebSocket did
 * not drain, `POST /hooks/pretooluse` was not read — another thread's approval
 * card simply hung — no timer fired and the Stop button did nothing. A `cmd
 * mcp` that blocked on a config lock or a slow filesystem wedged the server
 * with no bound and no way out but killing the process, since even the SIGINT
 * handler could not run until it returned.
 */
const MCP_TIMEOUT_MS = 10_000;

/** Runs one `cmd mcp …` subcommand for its exit code. Never throws. */
const runCmdMcp = (
  registration: McpRegistration,
  args: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const child = NodeChildProcess.execFile(
      registration.binaryPath,
      [...(registration.prefixArgs ?? []), "mcp", ...args, "--no-auto-update"],
      {
        cwd: registration.projectRoot,
        env: { ...registration.env },
        encoding: "utf8",
        timeout: registration.timeoutMs ?? MCP_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error) => {
        // Non-zero exit, a binary that is not there and the timeout kill all
        // arrive here as an error — and all three mean the same thing to the
        // caller: the harness did not take the entry.
        resume(Effect.succeed(error === null));
      },
    );
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });

/**
 * Registers the `openade` server in the project's local MCP scope — by asking
 * the CLI to do it.
 *
 * The file is `~/.commandcode/projects/<slug>/mcp.json`, and **that slug is
 * not something this connector can compute**. `slugFor` is a guess, every
 * recording's manifest says so (`transcriptDirMatchesConnectorSlug: false`),
 * and a real install splits camel humps where the guess does not:
 * `.../mcpslug.suYi/wsCamelCase` is filed under
 * `…-mcpslug-su-yi-ws-camel-case`, not `…-mcpslug.suyi-wscamelcase`.
 *
 * Writing the file ourselves therefore put the entry in a directory the
 * harness never reads, which meant OpenAde's browser tools were advertised to
 * nobody: the model was never offered a single one of them, in any session
 * this connector has ever opened. The transcript reader already refuses to
 * trust that slug and looks the session up by id instead — but an MCP entry
 * has to exist *before* the first run, when there is no session id yet.
 *
 * `cmd mcp add-json --scope local` knows where its own config lives, merges
 * into it, and writes exactly the shape we used to write by hand, placeholder
 * and all. It is also what `record-cmd.mjs` has always used to register the
 * recording MCP server. Answers `false` when the CLI refused, so the caller
 * can say the tools are unavailable this session rather than assume they are
 * there.
 */
export const upsertMcpEntry = (
  registration: McpRegistration,
  endpoint: { readonly url: string },
): Effect.Effect<boolean> =>
  runCmdMcp(registration, [
    "add-json",
    OPENADE_MCP_NAME,
    JSON.stringify({
      transport: "http",
      enabled: true,
      url: endpoint.url,
      headers: { Authorization: "Bearer ${OPENADE_MCP_TOKEN}" },
    }),
    "--scope",
    "local",
  ]).pipe(
    Effect.tap((registered) =>
      Effect.sync(() => {
        if (registered) {
          retainKey(mcpKey(registration.projectRoot));
        }
      }),
    ),
  );

/**
 * Removes the `openade` server entry, again through the CLI, so the same
 * merge that added it takes it away. The entry's *name* is the ownership
 * marker: a server the user added under any other name is untouched.
 *
 * Held per project root, the way the hook file is held per path.
 * `~/.commandcode/projects/<slug>/mcp.json` is keyed by the workspace, and
 * every thread of a project shares that workspace — so the first thread to
 * close used to run `cmd mcp remove` under a second thread that was still
 * running turns, and the model was offered none of OpenAde's browser tools for
 * the rest of that session, with no warning, because the removal succeeded.
 */
export const removeMcpEntry = (registration: McpRegistration): Effect.Effect<void> =>
  Effect.suspend(() =>
    release(mcpKey(registration.projectRoot))
      ? runCmdMcp(registration, ["remove", OPENADE_MCP_NAME, "--scope", "local"]).pipe(
          Effect.asVoid,
        )
      : Effect.void,
  );
