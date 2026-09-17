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
 * round-trip through the UI.
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

/** A missing or malformed file contributes no servers rather than failing. */
const readJsonFile = (path: string): Effect.Effect<Json> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.map((text) => {
      try {
        const parsed = JSON.parse(text) as unknown;
        return isJson(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }),
    Effect.orElseSucceed((): Json => ({})),
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
  readonly servers: Record<string, Json>;
}

const readMcpFile = (path: string): Effect.Effect<McpFile> =>
  Effect.map(readJsonFile(path), (doc) => ({
    doc,
    servers: isJson(doc.mcpServers)
      ? Object.fromEntries(
          Object.entries(doc.mcpServers).filter(([, entry]) => isJson(entry)) as Array<
            [string, Json]
          >,
        )
      : {},
  }));

const isManaged = (entry: Json): boolean => isJson(entry[MARKER]);

const entryToConfig = (
  name: string,
  scope: McpServerScope,
  entry: Json,
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
    enabled: marker.enabled !== false,
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
            const { servers } = yield* readMcpFile(file.path);
            for (const [name, entry] of Object.entries(servers)) {
              const config = entryToConfig(name, file.scope, entry);
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
            const existing = file.servers[server.name];
            if (existing !== undefined && !isManaged(existing)) {
              return yield* conflict(
                `"${server.name}" exists in ${path} without the ${MARKER} marker; edit it by hand or rename`,
              );
            }
            const doc: Json = { ...file.doc };
            const servers: Record<string, Json> = { ...file.servers };
            servers[server.name] = configToEntry(server);
            doc.mcpServers = servers;
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
            const existing = file.servers[name];
            if (existing === undefined) {
              return yield* notFound(`no server "${name}" in ${path}`);
            }
            if (!isManaged(existing)) {
              return yield* conflict(
                `"${name}" in ${path} was not written by OpenAde; refusing to remove it`,
              );
            }
            const doc: Json = { ...file.doc };
            const servers: Record<string, Json> = { ...file.servers };
            delete servers[name];
            doc.mcpServers = servers;
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
