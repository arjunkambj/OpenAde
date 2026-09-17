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
import { Settings } from "@OpenAde/contracts/settings";
import type { SettingsPatch } from "@OpenAde/contracts/settings";
import type { ConnectorInstanceId, ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
  }
>()("server/rpc/GitService") {
  static readonly empty = Layer.succeed(
    GitService,
    GitService.of({
      status: (_projectId) =>
        Effect.succeed({ branch: null, upstream: null, ahead: 0, behind: 0, files: [] }),
      diff: (_projectId, options) =>
        Effect.succeed({ from: options.from ?? null, to: options.to ?? null, files: [] }),
    }),
  );
}

// ── Browser (W6) ───────────────────────────────────────────────

export class BrowserService extends Context.Service<
  BrowserService,
  {
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<BrowserState>;
    /** `unknown` error: the RPC handler maps whatever an implementation fails with. */
    readonly humanInput: (
      threadId: ThreadId,
      input: BrowserHumanInput,
    ) => Effect.Effect<void, unknown>;
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
      return SettingsStore.of({
        get: SubscriptionRef.get(ref),
        freshInstall: loaded.freshInstall,
        update: (patch) =>
          Effect.gen(function* () {
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
        changes: SubscriptionRef.changes(ref),
      });
    }),
  );
}

const SETTINGS_ROW_KEY = "settings";

const DEFAULT_SETTINGS: Settings = {
  connectors: [],
  defaults: { model: null, effort: "medium", runtimeMode: "approval-required" },
  theme: "system",
  keybindings: [],
  permissions: [],
};

const load = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly value_json: string }>`
      SELECT value_json FROM settings WHERE key = ${SETTINGS_ROW_KEY}
    `;
    if (rows.length === 0) {
      return { settings: DEFAULT_SETTINGS, freshInstall: true };
    }
    const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Settings))(
      rows[0]!.value_json,
    ).pipe(Effect.catch(() => Effect.succeed(DEFAULT_SETTINGS)));
    return { settings, freshInstall: false };
  });
