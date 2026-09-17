/**
 * Reads and writes Command Code's own config files on behalf of the settings
 * UI: `~/.commandcode/mcp.json` (user scope) and `<workspaceRoot>/.mcp.json`
 * (project scope), plus skill discovery under the matching `skills` dirs.
 *
 * Ownership is per entry, not per file: every server OpenAde writes carries an
 * `_openade` marker object (`{ "enabled": boolean }`), and upsert/remove refuse
 * to touch an entry that lacks it. Everything else in the file — hand-authored
 * servers, unrelated top-level keys, formatting outside `mcpServers` — is
 * preserved verbatim on rewrite, so a hand edit outside our marker survives a
 * round-trip through the UI. A rewrite carries over the entries this module
 * cannot even read, too: it edits the maps the file holds rather than replacing
 * them with the filtered views listing uses.
 *
 * A file that exists but cannot be parsed is never rewritten: listing reports
 * no servers for it, and upsert/remove fail with a `conflict` naming the file,
 * because a rewrite would be built from an empty base and would delete every
 * server the user hand-authored.
 *
 * Disabling is a move, not a flag. Command Code launches everything under
 * `mcpServers` and ignores keys it does not recognise, so a disabled server's
 * definition is parked verbatim under `_openadeDisabled` and taken out of
 * `mcpServers`; re-enabling moves it back unchanged.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as NodePath from "node:path";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { McpServerConfig, McpServerScope, SkillSummary } from "@OpenAde/contracts/rpc";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isObject, isString } from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";

import { ReadModelStore } from "../persistence/ReadModels";
import { CmdConfig } from "../rpc/services";

/** Marker key on entries OpenAde manages. Presence means "ours". */
const MARKER = "_openade";

/**
 * Where a disabled server's definition is parked. Command Code launches every
 * entry under `mcpServers` and ignores keys it does not know, so "disabled"
 * has to mean "not in `mcpServers`" — a flag inside the entry would leave the
 * server running. The definition is kept verbatim here so re-enabling restores
 * it unchanged.
 */
const DISABLED_KEY = "_openadeDisabled";

type Json = Record<string, unknown>;

const isJson = isObject;

const stringRecord = (value: unknown): Record<string, string> => {
  if (!isJson(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isString(item)) {
      out[key] = item;
    }
  }
  return out;
};

const stringArray = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => isString(item)) : [];

/**
 * A file we are about to read-modify-write is one of three things, and the
 * difference decides whether writing it is safe. `missing` may be created;
 * `parsed` may be rewritten; `unreadable` — a trailing comma, a comment, a
 * permission error, a non-object top level — must never be rewritten, because
 * the rewrite would be built from an empty base and would drop every server
 * the user hand-authored.
 */
type JsonFile =
  | { readonly _tag: "missing" }
  | { readonly _tag: "parsed"; readonly doc: Json }
  | { readonly _tag: "unreadable"; readonly reason: string };

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isNotFound = (cause: unknown): boolean =>
  isObject(cause) && "code" in cause && cause.code === "ENOENT";

const readJsonFile = (path: string): Effect.Effect<JsonFile> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.map((text): JsonFile => {
      // An empty file is what `touch` leaves behind; treat it as creatable.
      if (text.trim() === "") {
        return { _tag: "parsed", doc: {} };
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        return isJson(parsed)
          ? { _tag: "parsed", doc: parsed }
          : { _tag: "unreadable", reason: "its top level is not a JSON object" };
      } catch (cause) {
        return { _tag: "unreadable", reason: describeCause(cause) };
      }
    }),
    Effect.catch((cause) =>
      Effect.succeed<JsonFile>(
        isNotFound(cause)
          ? { _tag: "missing" }
          : { _tag: "unreadable", reason: describeCause(cause) },
      ),
    ),
  );

const writeJsonFile = (path: string, doc: Json): Effect.Effect<void, OpenAdeRpcError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(NodePath.dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new OpenAdeRpcError({
        code: "internal",
        message: `cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// ── Entry mapping ──────────────────────────────────────────────

interface McpFile {
  readonly doc: Json;
  /** The live `mcpServers` map — everything the harness will launch. */
  readonly servers: Record<string, Json>;
  /** Managed definitions parked under `_openadeDisabled`. */
  readonly disabled: Record<string, Json>;
  /**
   * The same two maps as the file holds them, including the values the views
   * above filter out. A rewrite is built from these and touches only the one
   * key it changes, so an entry we cannot read — a `null`, a string, a park
   * without our marker — survives an edit to a different server.
   */
  readonly rawServers: Record<string, unknown>;
  readonly rawDisabled: Record<string, unknown>;
  /** Set when the file exists but could not be understood; writes must refuse. */
  readonly unreadable: string | null;
}

const jsonMap = (value: unknown): Record<string, Json> =>
  isJson(value)
    ? Object.fromEntries(
        Object.entries(value).filter(([, entry]) => isJson(entry)) as Array<[string, Json]>,
      )
    : {};

const rawMap = (value: unknown): Record<string, unknown> =>
  isJson(value) ? { ...(value as Record<string, unknown>) } : {};

const readMcpFile = (path: string): Effect.Effect<McpFile> =>
  Effect.map(readJsonFile(path), (file): McpFile => {
    if (file._tag === "unreadable") {
      return {
        doc: {},
        servers: {},
        disabled: {},
        rawServers: {},
        rawDisabled: {},
        unreadable: file.reason,
      };
    }
    const doc = file._tag === "missing" ? {} : file.doc;
    return {
      doc,
      servers: jsonMap(doc.mcpServers),
      // Only our own entries are honoured there; anything else in that key is
      // left alone and reported by nothing.
      disabled: Object.fromEntries(
        Object.entries(jsonMap(doc[DISABLED_KEY])).filter(([, entry]) => isManaged(entry)),
      ),
      rawServers: rawMap(doc.mcpServers),
      rawDisabled: rawMap(doc[DISABLED_KEY]),
      unreadable: null,
    };
  });

const isManaged = (entry: Json): boolean => isJson(entry[MARKER]);

const entryToConfig = (
  name: string,
  scope: McpServerScope,
  entry: Json,
  /** `false` for an entry parked outside `mcpServers`, whatever its marker says. */
  live = true,
): McpServerConfig | null => {
  const type = isString(entry.type) ? entry.type : null;
  const command = isString(entry.command) ? entry.command : null;
  const url = isString(entry.url) ? entry.url : null;
  // Claude-Code-compatible inference: a bare `command` means stdio, a bare
  // `url` means http; `sse` is reported to us as http-family.
  const transport =
    type === "stdio" || (type === null && command !== null)
      ? ("stdio" as const)
      : type === "http" || type === "sse" || (type === null && url !== null)
        ? ("http" as const)
        : null;
  if (transport === null || (transport === "stdio" && command === null)) {
    return null;
  }
  if (transport === "http" && url === null) {
    return null;
  }
  const marker = isJson(entry[MARKER]) ? entry[MARKER] : {};
  const base = {
    name,
    scope,
    enabled: live && marker.enabled !== false,
    managed: isManaged(entry),
    transport,
  };
  if (transport === "stdio") {
    const args = stringArray(entry.args);
    const env = stringRecord(entry.env);
    return {
      ...base,
      ...(command === null ? {} : { command }),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const headers = stringRecord(entry.headers);
  return {
    ...base,
    ...(url === null ? {} : { url }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
};

const configToEntry = (server: McpServerConfig): Json => {
  const entry: Json = { type: server.transport };
  if (server.transport === "stdio") {
    entry.command = server.command ?? "";
    if (server.args !== undefined && server.args.length > 0) {
      entry.args = [...server.args];
    }
    if (server.env !== undefined && Object.keys(server.env).length > 0) {
      entry.env = { ...server.env };
    }
  } else {
    entry.url = server.url ?? "";
    if (server.headers !== undefined && Object.keys(server.headers).length > 0) {
      entry.headers = { ...server.headers };
    }
  }
  entry[MARKER] = { enabled: server.enabled };
  return entry;
};

/**
 * Writes the park back, dropping the key entirely once nothing is parked at
 * all — `disabled` is the raw map, so a hand-written entry there keeps the key.
 */
const writeDisabled = (doc: Json, disabled: Record<string, unknown>): void => {
  if (Object.keys(disabled).length === 0) {
    delete doc[DISABLED_KEY];
    return;
  }
  doc[DISABLED_KEY] = disabled;
};

// ── Skills ─────────────────────────────────────────────────────

/** Minimal `---` frontmatter: `name` and `description` only, like the skills dirs use. */
const parseFrontmatter = (content: string): { name?: string; description?: string } => {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return {};
  }
  const out: { name?: string; description?: string } = {};
  for (const line of content.slice(3, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match === null) {
      continue;
    }
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (match[1]!.toLowerCase() === "name") {
      out.name = value;
    } else if (match[1]!.toLowerCase() === "description") {
      out.description = value;
    }
  }
  return out;
};

const fileStem = (path: string): string => {
  const base = NodePath.basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

const readSafe = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => null));

const listDirSafe = (path: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(path)).pipe(Effect.orElseSucceed(() => []));

const statSafe = (path: string) =>
  Effect.tryPromise(() => stat(path)).pipe(Effect.orElseSucceed(() => null));

const isDirSafe = (path: string): Effect.Effect<boolean> =>
  Effect.map(statSafe(path), (info) => info?.isDirectory() ?? false);

const existsSafe = (path: string): Effect.Effect<boolean> =>
  Effect.map(statSafe(path), (info) => info !== null);

/**
 * One skills root, walked tolerantly. Both `<root>/<name>/SKILL.md` and
 * `<root>/<name>.md` appear in the wild; either is a skill.
 */
const readSkillsRoot = (root: string): Effect.Effect<ReadonlyArray<SkillSummary>> =>
  Effect.gen(function* () {
    const entries = yield* listDirSafe(root);
    const out: Array<SkillSummary> = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) {
        continue;
      }
      const absolute = NodePath.join(root, entry);
      let filePath: string | null = null;
      let name = fileStem(entry);
      if (yield* isDirSafe(absolute)) {
        name = entry;
        for (const candidate of ["SKILL.md", "skill.md", `${entry}.md`]) {
          const file = NodePath.join(absolute, candidate);
          if (yield* existsSafe(file)) {
            filePath = file;
            break;
          }
        }
      } else if (entry.endsWith(".md")) {
        filePath = absolute;
      }
      if (filePath === null) {
        continue;
      }
      const content = yield* readSafe(filePath);
      if (content === null) {
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      out.push({
        name: frontmatter.name ?? name,
        path: filePath,
        ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
        enabled: true,
      });
    }
    return out;
  });

// ── The service ────────────────────────────────────────────────

export interface CmdConfigOptions {
  /**
   * Command Code's home directory — `~/.commandcode` in production. Tests pass
   * a temporary directory so no real user config is touched.
   */
  readonly commandCodeHome?: string;
}

const conflict = (message: string) => new OpenAdeRpcError({ code: "conflict", message });
const notFound = (message: string) => new OpenAdeRpcError({ code: "not-found", message });

/**
 * The refusal that keeps a file we cannot parse intact. Rewriting it would
 * rebuild it from an empty base and silently delete every server in it.
 */
const unreadableConflict = (path: string, reason: string) =>
  conflict(`cannot read ${path} (${reason}); fix it by hand first — refusing to rewrite it`);

/** @public Wired in `main.ts`; replaces `CmdConfig.empty`. */
export const layer = (options: CmdConfigOptions = {}) =>
  Layer.effect(
    CmdConfig,
    Effect.gen(function* () {
      const readModels = yield* ReadModelStore;
      const home = options.commandCodeHome ?? NodePath.join(homedir(), ".commandcode");
      const userMcpPath = NodePath.join(home, "mcp.json");
      const userSkillsRoot = NodePath.join(home, "skills");
      // Writers serialise so a concurrent upsert+remove cannot interleave a
      // read-modify-write of the same file.
      const writeMutex = yield* Semaphore.make(1);

      const projectRoot = (projectId: ProjectId | undefined) =>
        projectId === undefined
          ? Effect.succeed(null)
          : readModels.getProjectDoc(projectId).pipe(
              Effect.map((doc) => doc?.workspaceRoot ?? null),
              Effect.mapError(
                (error) =>
                  new OpenAdeRpcError({
                    code: "internal",
                    message: `project lookup failed: ${error.message}`,
                  }),
              ),
            );

      const projectMcpPath = (root: string) => NodePath.join(root, ".mcp.json");
      const projectSkillsRoot = (root: string) => NodePath.join(root, ".commandcode", "skills");

      const fileForScope = (scope: McpServerScope, root: string | null) =>
        scope === "user" ? userMcpPath : root === null ? null : projectMcpPath(root);

      const mcpList = (projectId?: ProjectId) =>
        Effect.gen(function* () {
          const root = yield* projectRoot(projectId);
          const files: Array<{ path: string; scope: McpServerScope }> = [
            { path: userMcpPath, scope: "user" },
          ];
          if (root !== null) {
            files.push({ path: projectMcpPath(root), scope: "project" });
          }
          const out: Array<McpServerConfig> = [];
          for (const file of files) {
            const { servers, disabled } = yield* readMcpFile(file.path);
            for (const [name, entry] of Object.entries(servers)) {
              const config = entryToConfig(name, file.scope, entry);
              if (config !== null) {
                out.push(config);
              }
            }
            // Parked definitions are still ours to show and edit; they just do
            // not run. A name in both maps is a hand edit re-adding it — the
            // live one wins, since that is what the harness will launch.
            for (const [name, entry] of Object.entries(disabled)) {
              if (servers[name] !== undefined) {
                continue;
              }
              const config = entryToConfig(name, file.scope, entry, false);
              if (config !== null) {
                out.push(config);
              }
            }
          }
          return out;
        });

      const mcpUpsert = (projectId: ProjectId | undefined, server: McpServerConfig) =>
        writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const root = yield* projectRoot(projectId);
            const path = fileForScope(server.scope, root);
            if (path === null) {
              return yield* notFound(
                "project scope needs a project; pass projectId for a project-scope server",
              );
            }
            const file = yield* readMcpFile(path);
            if (file.unreadable !== null) {
              return yield* unreadableConflict(path, file.unreadable);
            }
            const existing = file.servers[server.name];
            if (existing !== undefined && !isManaged(existing)) {
              return yield* conflict(
                `"${server.name}" exists in ${path} without the ${MARKER} marker; edit it by hand or rename`,
              );
            }
            // Built from the raw maps: every key but this server's is written
            // back exactly as it was read, whatever its value looks like.
            const doc: Json = { ...file.doc };
            const servers = { ...file.rawServers };
            const disabled = { ...file.rawDisabled };
            const entry = configToEntry(server);
            // Enabled means "in the map the harness launches"; disabled means
            // "parked in our own key". A flag alone would not stop the server.
            if (server.enabled) {
              servers[server.name] = entry;
              delete disabled[server.name];
            } else {
              disabled[server.name] = entry;
              delete servers[server.name];
            }
            doc.mcpServers = servers;
            writeDisabled(doc, disabled);
            yield* writeJsonFile(path, doc);
            return yield* mcpList(projectId);
          }),
        );

      const mcpRemove = (projectId: ProjectId | undefined, scope: McpServerScope, name: string) =>
        writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const root = yield* projectRoot(projectId);
            const path = fileForScope(scope, root);
            if (path === null) {
              return yield* notFound(
                "project scope needs a project; pass projectId for a project-scope server",
              );
            }
            const file = yield* readMcpFile(path);
            if (file.unreadable !== null) {
              return yield* unreadableConflict(path, file.unreadable);
            }
            const existing = file.servers[name] ?? file.disabled[name];
            if (existing === undefined) {
              return yield* notFound(`no server "${name}" in ${path}`);
            }
            if (!isManaged(existing)) {
              return yield* conflict(
                `"${name}" in ${path} was not written by OpenAde; refusing to remove it`,
              );
            }
            const doc: Json = { ...file.doc };
            const servers = { ...file.rawServers };
            const disabled = { ...file.rawDisabled };
            delete servers[name];
            delete disabled[name];
            doc.mcpServers = servers;
            writeDisabled(doc, disabled);
            yield* writeJsonFile(path, doc);
            return yield* mcpList(projectId);
          }),
        );

      const skillsList = (projectId?: ProjectId) =>
        Effect.gen(function* () {
          const root = yield* projectRoot(projectId);
          const roots: Array<string> = [];
          if (root !== null) {
            roots.push(projectSkillsRoot(root));
          }
          roots.push(userSkillsRoot);
          // Project skills win name collisions, matching harness precedence.
          const seen = new Set<string>();
          const out: Array<SkillSummary> = [];
          for (const skillsRoot of roots) {
            for (const skill of yield* readSkillsRoot(skillsRoot)) {
              if (seen.has(skill.name)) {
                continue;
              }
              seen.add(skill.name);
              out.push(skill);
            }
          }
          return out;
        });

      return CmdConfig.of({ mcpList, mcpUpsert, mcpRemove, skillsList });
    }),
  );
