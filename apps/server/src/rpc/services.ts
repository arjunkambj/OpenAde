/**
 * Service interfaces behind the RPC surface. Everything here that belongs to
 * another workstream (W2 connectors, W6 browser, W8 files/git, W9 config) gets
 * an in-memory implementation now so the server runs end to end; those
 * workstreams swap the layer, not the contract.
 */

import type {
  BrowserHumanInput,
  BrowserState,
  ConnectorSummary,
  FileContent,
  FileSearchResult,
  GitDiff,
  GitStatus,
  McpServerConfig,
  McpServerScope,
  ModelOption,
  SkillSummary,
} from "@OpenAde/contracts/rpc";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import { defaultSettings, Settings } from "@OpenAde/contracts/settings";
import type { SettingsPatch } from "@OpenAde/contracts/settings";
import type { ConnectorInstanceId, ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BrowserCallOutcome } from "../browser/tools";

// ── Server identity ────────────────────────────────────────────

/** Minted once at boot; a changed value tells clients to resnapshot. */
export class ServerIdentity extends Context.Service<
  ServerIdentity,
  {
    readonly serverInstanceId: string;
  }
>()("server/rpc/ServerIdentity") {}

// ── Connectors (W2 fills the real implementation) ──────────────

export class ConnectorCatalog extends Context.Service<
  ConnectorCatalog,
  {
    /** `refresh` re-runs each connector's probe before answering. */
    readonly list: (refresh?: boolean) => Effect.Effect<ReadonlyArray<ConnectorSummary>>;
    readonly models: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<ModelOption>>;
  }
>()("server/rpc/ConnectorCatalog") {
  static readonly empty = Layer.succeed(
    ConnectorCatalog,
    ConnectorCatalog.of({
      list: () => Effect.succeed([]),
      models: () => Effect.succeed([]),
    }),
  );
}

// ── Files (W8) ─────────────────────────────────────────────────

export class FileService extends Context.Service<
  FileService,
  {
    readonly search: (
      projectId: ProjectId,
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<FileSearchResult>, OpenAdeRpcError>;
    readonly read: (
      projectId: ProjectId,
      path: string,
      offset?: number,
      limit?: number,
    ) => Effect.Effect<FileContent, OpenAdeRpcError>;
  }
>()("server/rpc/FileService") {
  static readonly empty = Layer.succeed(
    FileService,
    FileService.of({
      search: (_projectId, _query, _limit) => Effect.succeed([]),
      read: (_projectId, path) =>
        Effect.succeed({ path, text: "", totalLines: 0, truncated: false }),
    }),
  );
}

// ── Git (W8) ───────────────────────────────────────────────────

export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (projectId: ProjectId) => Effect.Effect<GitStatus, OpenAdeRpcError>;
    readonly diff: (
      projectId: ProjectId,
      options: {
        readonly from?: string;
        readonly to?: string;
        readonly path?: string;
      },
    ) => Effect.Effect<GitDiff, OpenAdeRpcError>;
    /** The checkpoint refs that still exist for a thread, oldest first. */
    readonly checkpoints: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<CheckpointSummary>, OpenAdeRpcError>;
  }
>()("server/rpc/GitService") {
  static readonly empty = Layer.succeed(
    GitService,
    GitService.of({
      status: (_projectId) =>
        Effect.succeed({ branch: null, upstream: null, ahead: 0, behind: 0, files: [] }),
      diff: (_projectId, options) =>
        Effect.succeed({ from: options.from ?? null, to: options.to ?? null, files: [] }),
      checkpoints: () => Effect.succeed([]),
    }),
  );
}

// ── Browser (W6) ───────────────────────────────────────────────

/**
 * The browser pane's session service. `subscribe`/`humanInput` are the wire
 * surface; `callTool` is the MCP layer's entry into the same per-thread
 * serialized queue (tool failures and human interruption come back inside the
 * outcome); `teardown` is the thread-close hook.
 */
export class BrowserService extends Context.Service<
  BrowserService,
  {
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<BrowserState>;
    /** `unknown` error: the RPC handler maps whatever an implementation fails with. */
    readonly humanInput: (
      threadId: ThreadId,
      input: BrowserHumanInput,
    ) => Effect.Effect<void, unknown>;
    readonly callTool: (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ) => Effect.Effect<BrowserCallOutcome>;
    readonly teardown: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("server/rpc/BrowserService") {
  static readonly empty = Layer.succeed(
    BrowserService,
    BrowserService.of({
      subscribe: (threadId) =>
        Stream.make({
          threadId,
          status: "stopped" as const,
          mode: "cdp-attach" as const,
          url: null,
          title: null,
          frame: null,
        }),
      humanInput: () => Effect.void,
      callTool: () => Effect.succeed({ kind: "error", message: "browser service unavailable" }),
      teardown: () => Effect.void,
    }),
  );
}

// ── Command Code config (W9) ───────────────────────────────────

export class CmdConfig extends Context.Service<
  CmdConfig,
  {
    readonly mcpList: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, OpenAdeRpcError>;
    readonly mcpUpsert: (
      projectId: ProjectId | undefined,
      server: McpServerConfig,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, OpenAdeRpcError>;
    readonly mcpRemove: (
      projectId: ProjectId | undefined,
      scope: McpServerScope,
      name: string,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, OpenAdeRpcError>;
    readonly skillsList: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<SkillSummary>, OpenAdeRpcError>;
  }
>()("server/rpc/CmdConfig") {
  static readonly empty = Layer.succeed(
    CmdConfig,
    CmdConfig.of({
      mcpList: () => Effect.succeed([]),
      mcpUpsert: () => Effect.succeed([]),
      mcpRemove: () => Effect.succeed([]),
      skillsList: () => Effect.succeed([]),
    }),
  );
}

// ── Settings (real: backed by the `settings` table) ────────────

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    readonly update: (
      patch: SettingsPatch,
    ) => Effect.Effect<Settings, import("effect/unstable/sql/SqlError").SqlError>;
    /** Emits the current settings, then every update. */
    readonly changes: Stream.Stream<Settings>;
    /**
     * True when no `settings` row existed at boot. The connector manager reads
     * this to seed a default instance on first run only — a user who later
     * removes every connector must not see it resurrected on the next boot.
     */
    readonly freshInstall: boolean;
  }
>()("server/rpc/SettingsStore") {
  /**
   * Persists the whole settings document as one JSON row — the same table the
   * engine uses, so the app never has two sources of truth for preferences.
   */
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const loaded = yield* load(sql);
      const ref = yield* SubscriptionRef.make<Settings>(loaded.settings);
      /** The undecodable row, until the first write has archived it. */
      const unreadable = yield* Ref.make<string | null>(loaded.unreadable);
      /**
       * The document is written whole, so a read-modify-write that yields in
       * the middle loses the other writer's fields entirely — two windows
       * saving different pages at the same moment was enough. Serialised the
       * way CmdConfig serialises its own writes.
       */
      const writeMutex = yield* Semaphore.make(1);
      return SettingsStore.of({
        get: SubscriptionRef.get(ref),
        freshInstall: loaded.freshInstall,
        update: (patch) =>
          writeMutex.withPermits(1)(
            Effect.gen(function* () {
              const archive = yield* Ref.getAndSet(unreadable, null);
              if (archive !== null) {
                yield* sql`
                INSERT INTO settings (key, value_json, updated_at)
                VALUES (${SETTINGS_UNREADABLE_ROW_KEY}, ${archive}, ${new Date().toISOString()})
                ON CONFLICT (key) DO NOTHING
              `;
              }
              const current = yield* SubscriptionRef.get(ref);
              const next: Settings = {
                ...current,
                ...Object.fromEntries(
                  Object.entries(patch).filter(([, value]) => value !== undefined),
                ),
              };
              yield* sql`
              INSERT INTO settings (key, value_json, updated_at)
              VALUES (${SETTINGS_ROW_KEY}, ${JSON.stringify(next)}, ${new Date().toISOString()})
              ON CONFLICT (key) DO UPDATE
                SET value_json = excluded.value_json, updated_at = excluded.updated_at
            `;
              yield* SubscriptionRef.set(ref, next);
              return next;
            }),
          ),
        changes: SubscriptionRef.changes(ref),
      });
    }),
  );
}

const SETTINGS_ROW_KEY = "settings";

/**
 * The server has no defaults of its own: the contracts' document is what the
 * keybindings page diffs a user's overrides against, so a second copy here
 * would silently drift (it did — it shipped an empty keybinding table, which
 * disabled every shortcut in the app).
 */

/**
 * Repairs a document written by the build whose defaults had no keybindings.
 * The editor cannot add a binding back, so an empty table is not a state a
 * user can have chosen or escape from — it only ever means that bug.
 */
const healed = (settings: Settings): Settings =>
  settings.keybindings.length === 0
    ? { ...settings, keybindings: defaultSettings().keybindings }
    : settings;

/**
 * Where a row this build cannot decode is kept. One field from a newer build,
 * or one truncated write, used to be swallowed silently and then overwritten
 * by the first save — taking the user's connector instances and permission
 * rules with it. The raw text is copied here instead, and never clobbered, so
 * a downgrade or a hand repair still has the original.
 */
const SETTINGS_UNREADABLE_ROW_KEY = "settings.unreadable";

const load = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly value_json: string }>`
      SELECT value_json FROM settings WHERE key = ${SETTINGS_ROW_KEY}
    `;
    if (rows.length === 0) {
      return { settings: defaultSettings(), freshInstall: true, unreadable: null };
    }
    const raw = rows[0]!.value_json;
    const decoded = yield* Effect.exit(Schema.decodeEffect(Schema.fromJsonString(Settings))(raw));
    if (decoded._tag === "Failure") {
      yield* Effect.logError("settings row could not be decoded; serving defaults", decoded.cause);
      return { settings: defaultSettings(), freshInstall: false, unreadable: raw };
    }
    return { settings: healed(decoded.value), freshInstall: false, unreadable: null };
  });
