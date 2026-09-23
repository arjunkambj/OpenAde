/**
 * Service interfaces behind the RPC surface. Each surface the orchestration
 * layer does not own itself — connectors, the browser, files and git, the
 * harness's own config — is a Tag with an in-memory implementation here, so
 * the server runs end to end with any of them swapped for a fake. The real
 * implementations provide the layer; none of them touches this contract.
 */

import type {
  AgentSkill,
  ConnectorDescriptor,
  ConnectorSummary,
  McpServerConfig,
  McpServerScope,
  ModelOption,
  SkillSummary,
} from "@OpenAde/contracts/connectors";
import type {
  BrowserHumanInput,
  BrowserState,
  FileContent,
  FileSearchResult,
  FsListing,
  GitDiff,
  GitStatus,
} from "@OpenAde/contracts/rpc";
import { FsBrowseError, OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import { defaultSettings, Settings } from "@OpenAde/contracts/settings";
import type { SettingsPatch } from "@OpenAde/contracts/settings";
import type { ConnectorInstanceId, ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PERMISSION_RULES_KEY, readRules, writeRules } from "../permissions/PermissionService";
import { layer as migrationsLayer } from "../persistence/Migrations";
import type { BrowserCallOutcome } from "../browser/tools";

// ── Server identity ────────────────────────────────────────────

/** Minted once at boot; a changed value tells clients to resnapshot. */
export class ServerIdentity extends Context.Service<
  ServerIdentity,
  {
    readonly serverInstanceId: string;
  }
>()("server/rpc/ServerIdentity") {}

// ── Connectors ─────────────────────────────────────────────────

export class ConnectorCatalog extends Context.Service<
  ConnectorCatalog,
  {
    /** `refresh` re-runs each connector's probe before answering. */
    readonly list: (refresh?: boolean) => Effect.Effect<ReadonlyArray<ConnectorSummary>>;
    readonly models: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<ModelOption>>;
    /** Every connector this build ships, configured or not, with its metadata and form. */
    readonly describe: Effect.Effect<ReadonlyArray<ConnectorDescriptor>>;
  }
>()("server/rpc/ConnectorCatalog") {
  static readonly empty = Layer.succeed(
    ConnectorCatalog,
    ConnectorCatalog.of({
      list: () => Effect.succeed([]),
      models: () => Effect.succeed([]),
      describe: Effect.succeed([]),
    }),
  );
}

// ── Files ──────────────────────────────────────────────────────

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

// ── Directory browsing (the folder picker) ─────────────────────

/**
 * `fs.browse` behind a Tag like everything else, though it has only ever had
 * one implementation: the picker's listing is a filesystem read that a test
 * (and, later, a host that is not this machine) has every reason to replace
 * without the handler knowing.
 */
export class DirectoryBrowser extends Context.Service<
  DirectoryBrowser,
  {
    readonly browse: (input: {
      /** Absolute. Omitted means the server user's home directory. */
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
    }) => Effect.Effect<FsListing, FsBrowseError>;
  }
>()("server/rpc/DirectoryBrowser") {}

// ── Git ────────────────────────────────────────────────────────

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

// ── Browser ────────────────────────────────────────────────────

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

// ── Command Code config ────────────────────────────────────────

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
    readonly skillsAgents: Effect.Effect<ReadonlyArray<AgentSkill>, OpenAdeRpcError>;
    readonly skillsLink: (
      entry: string,
    ) => Effect.Effect<ReadonlyArray<AgentSkill>, OpenAdeRpcError>;
  }
>()("server/rpc/CmdConfig") {
  static readonly empty = Layer.succeed(
    CmdConfig,
    CmdConfig.of({
      mcpList: () => Effect.succeed([]),
      mcpUpsert: () => Effect.succeed([]),
      mcpRemove: () => Effect.succeed([]),
      skillsList: () => Effect.succeed([]),
      skillsAgents: Effect.succeed([]),
      skillsLink: () => Effect.succeed([]),
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
   *
   * `permissions` is the exception, and for the same reason: the rules live in
   * `permission_rules`, because the ladder filters them by scope on every tool
   * call and "allow always" appends a row from the approval flow. The document
   * projects that table on read and writes it back on update, so a rule the
   * user adds here is enforced and a rule the approval flow wrote shows up
   * here. The JSON copy is always stored empty so it can never disagree.
   *
   * The migrations are a layer input rather than something the entrypoint runs
   * first: this one reads its table while the graph is still being built, so
   * "the schema exists" has to be an edge in the graph or it is a race.
   */
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reactivity = yield* Reactivity.Reactivity;
      const loaded = yield* load(sql);
      const ref = yield* Ref.make<Settings>(loaded.settings);
      /**
       * The document's one change feed, replaying the current value so a late
       * subscriber starts from it.
       *
       * It is a hub of its own rather than a `SubscriptionRef`'s, because two
       * different things make this document change: a write through `update`,
       * and a rule appended straight to `permission_rules` by the approval
       * card's "allow always". The second leaves the stored row untouched, so
       * there is no new *value* to set — only the same document to re-read.
       * One feed both can publish to keeps `changes` a single subscription,
       * which is also what makes it impossible for a subscriber to be attached
       * to one source and miss the other.
       *
       * Sliding, and one deep. `settings.subscribe` hands this stream straight
       * to a WebSocket client, and an unbounded hub would let a stalled one
       * grow a queue of whole settings documents on the server — the same leak
       * the gateway and browser reactors carry a warning about. Dropping the
       * older element is lossless here: every element is the entire current
       * document, so the newest one says everything the ones behind it did.
       */
      const feed = yield* PubSub.sliding<Settings>({ capacity: 1, replay: 1 });
      yield* PubSub.publish(feed, loaded.settings);
      // Registered for the layer's lifetime — before any subscriber exists, so
      // no rule can be written into a gap where nothing is listening.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          reactivity.registerUnsafe([PERMISSION_RULES_KEY], () => {
            PubSub.publishUnsafe(feed, Ref.getUnsafe(ref));
          }),
        ),
        (unregister) => Effect.sync(unregister),
      );
      /** The undecodable row, until the first write has archived it. */
      const unreadable = yield* Ref.make<string | null>(loaded.unreadable);
      /**
       * The document is written whole, so a read-modify-write that yields in
       * the middle loses the other writer's fields entirely — two windows
       * saving different pages at the same moment was enough. Serialised the
       * way CmdConfig serialises its own writes.
       */
      const writeMutex = yield* Semaphore.make(1);

      /** The stored document with the live rules folded in. */
      const withRules = (settings: Settings) =>
        readRules(sql).pipe(
          Effect.map((permissions): Settings => ({ ...settings, permissions })),
          // `get` has no error channel, and a settings read must not fail over
          // the rules table — the last known list is better than nothing.
          Effect.catch(() => Effect.succeed(settings)),
        );

      return SettingsStore.of({
        get: Ref.get(ref).pipe(Effect.flatMap(withRules)),
        freshInstall: loaded.freshInstall,
        update: (patch) =>
          writeMutex.withPermits(1)(
            Effect.gen(function* () {
              const archive = yield* Ref.get(unreadable);
              const current = yield* Ref.get(ref);
              const next: Settings = {
                ...current,
                ...Object.fromEntries(
                  Object.entries(patch).filter(([, value]) => value !== undefined),
                ),
              };
              const stored: Settings = { ...next, permissions: [] };
              // The rules table and the document are one edit. `writeRules`
              // replaces the whole table, so a failure between the two halves
              // would leave the user's rules gone and their preferences
              // unwritten — with nothing to tell them which half took.
              //
              // The archive is the same edit for the same reason: this write is
              // what destroys the undecodable row, so the copy has to become
              // durable exactly when the row that replaces it does.
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  if (archive !== null) {
                    yield* sql`
                      INSERT INTO settings (key, value_json, updated_at)
                      VALUES (
                        ${SETTINGS_UNREADABLE_ROW_KEY}, ${archive},
                        ${new Date().toISOString()}
                      )
                      ON CONFLICT (key) DO NOTHING
                    `;
                  }
                  if (patch.permissions !== undefined) {
                    yield* writeRules(sql, patch.permissions);
                  }
                  yield* sql`
                    INSERT INTO settings (key, value_json, updated_at)
                    VALUES (
                      ${SETTINGS_ROW_KEY}, ${JSON.stringify(stored)},
                      ${new Date().toISOString()}
                    )
                    ON CONFLICT (key) DO UPDATE
                      SET value_json = excluded.value_json, updated_at = excluded.updated_at
                  `;
                }),
              );
              // Only now: a rolled-back transaction has to leave the raw text
              // still in hand for the next attempt.
              yield* Ref.set(unreadable, null);
              yield* Ref.set(ref, stored);
              yield* PubSub.publish(feed, stored);
              return yield* withRules(stored);
            }),
          ),
        // `withRules` on the way out: what a subscriber is owed is the document
        // *plus* the rules as they are now, which is exactly what a rules-only
        // change republishes the unchanged stored value for.
        changes: Stream.fromPubSub(feed).pipe(Stream.mapEffect(withRules)),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}

const SETTINGS_ROW_KEY = "settings";

/**
 * The server has no defaults of its own: the contracts' document is what the
 * keybindings page diffs a user's overrides against, so a second copy here
 * would silently drift (it did — it shipped an empty keybinding table, which
 * disabled every shortcut in the app).
 */

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
    // A stored document is served exactly as written: the keybindings page can
    // add, remove and reset rows, so an empty table is a choice the user made
    // and a "repair" here would silently revert it on the next server start.
    return { settings: decoded.value, freshInstall: false, unreadable: null };
  });
