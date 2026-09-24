/**
 * Command Code's MCP server files, read and written for the Customize page:
 * `<home>/mcp.json` (user scope) and `<workspaceRoot>/.mcp.json` (project
 * scope). This is the `mcpServers` extension; `config.ts` is the unrelated
 * per-session `poseidon` entry the CLI writes for us.
 *
 * Ownership is per entry, not per file: every server Poseidon writes carries an
 * `_poseidon` marker object (`{ "enabled": boolean }`), and add/remove refuse
 * to touch an entry that lacks it. Everything else in the file — hand-authored
 * servers, unrelated top-level keys, formatting outside `mcpServers` — is
 * preserved verbatim on rewrite, so a hand edit outside our marker survives a
 * round-trip through the UI. A rewrite carries over the entries this module
 * cannot even read, too: it edits the maps the file holds rather than replacing
 * them with the filtered views listing uses.
 *
 * A file that exists but cannot be parsed is never rewritten: listing reports
 * no servers for it, and add/remove fail with a `conflict` naming the file,
 * because a rewrite would be built from an empty base and would delete every
 * server the user hand-authored.
 *
 * Disabling is a move, not a flag. Command Code launches everything under
 * `mcpServers` and ignores keys it does not recognise, so a disabled server's
 * definition is parked verbatim under `_poseidonDisabled` and taken out of
 * `mcpServers`; re-enabling moves it back unchanged.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import type { ExtensionScope, McpServersExtension } from "@poseidon/connector-sdk/extensions";
import type { McpServerConfig, McpServerScope } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import { isObject, isString } from "effect/Predicate";
import type * as Semaphore from "effect/Semaphore";

/** Marker key on entries Poseidon manages. Presence means "ours". */
const MARKER = "_poseidon";

/**
 * Where a disabled server's definition is parked. Command Code launches every
 * entry under `mcpServers` and ignores keys it does not know, so "disabled"
 * has to mean "not in `mcpServers`" — a flag inside the entry would leave the
 * server running. The definition is kept verbatim here so re-enabling restores
 * it unchanged.
 */
const DISABLED_KEY = "_poseidonDisabled";

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

const writeJsonFile = (path: string, doc: Json): Effect.Effect<void, ConnectorExtensionFailed> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(NodePath.dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new ConnectorExtensionFailed({
        code: "internal",
        message: `cannot write ${path}: ${describeCause(cause)}`,
      }),
  });

// ── Entry mapping ──────────────────────────────────────────────

interface McpFile {
  readonly doc: Json;
  /** The live `mcpServers` map — everything the harness will launch. */
  readonly servers: Record<string, Json>;
  /** Managed definitions parked under `_poseidonDisabled`. */
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

const isManaged = (entry: Json): boolean => isJson(entry[MARKER]);

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
  // The common `mcp.json` inference: a bare `command` means stdio, a bare
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

// ── The extension ──────────────────────────────────────────────

const conflict = (message: string) => new ConnectorExtensionFailed({ code: "conflict", message });
const notFound = (message: string) => new ConnectorExtensionFailed({ code: "not-found", message });

/**
 * The refusal that keeps a file we cannot parse intact. Rewriting it would
 * rebuild it from an empty base and silently delete every server in it.
 */
const unreadableConflict = (path: string, reason: string) =>
  conflict(`cannot read ${path} (${reason}); fix it by hand first — refusing to rewrite it`);

const needsProject = () =>
  notFound("project scope needs a project; pass projectId for a project-scope server");

export interface CmdMcpServersOptions {
  /** Command Code's home directory — `~/.commandcode` in production. */
  readonly home: string;
  /** Serialises writers, so an add and a remove never interleave on one file. */
  readonly writeMutex: Semaphore.Semaphore;
}

export const makeCmdMcpServers = (options: CmdMcpServersOptions): McpServersExtension => {
  const userMcpPath = NodePath.join(options.home, "mcp.json");
  const projectMcpPath = (root: string) => NodePath.join(root, ".mcp.json");
  const fileForScope = (serverScope: McpServerScope, root: string | null) =>
    serverScope === "user" ? userMcpPath : root === null ? null : projectMcpPath(root);

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      const files: Array<{ path: string; scope: McpServerScope }> = [
        { path: userMcpPath, scope: "user" },
      ];
      if (scope.workspaceRoot !== null) {
        files.push({ path: projectMcpPath(scope.workspaceRoot), scope: "project" });
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

  const add = (scope: ExtensionScope, server: McpServerConfig) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const path = fileForScope(server.scope, scope.workspaceRoot);
        if (path === null) {
          return yield* needsProject();
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
        return yield* list(scope);
      }),
    );

  const remove = (scope: ExtensionScope, serverScope: McpServerScope, name: string) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const path = fileForScope(serverScope, scope.workspaceRoot);
        if (path === null) {
          return yield* needsProject();
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
            `"${name}" in ${path} was not written by Poseidon; refusing to remove it`,
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
        return yield* list(scope);
      }),
    );

  return { list, add, remove };
};
