/**
 * The permission engine: `deny → ask → allow`.
 *
 * `decidePermission` is the pure ladder the 100-row table test drives:
 *
 * 1. A `deny` rule that matches → `deny`.
 * 2. Plan mode (`interactionMode: "plan"`) → anything that isn't a read is
 *    `deny` — plan mode is read-only.
 * 3. A sensitive path → `prompt`, whether it is the subject of a file request
 *    or an argument of a shell command. "Ask" outranks allow rules: a
 *    remembered `allow` can never skip the secrets check.
 * 4. An `allow` rule that matches → `allow`.
 * 5. Reads are always safe → `allow`.
 * 6. The runtime mode decides the rest: `approval-required` asks,
 *    `auto-accept-edits` allows writes but still asks for commands and
 *    network, `full-access` allows everything that got this far.
 *
 * `PermissionService` is the same ladder over the `permission_rules` table,
 * filtered to the rules whose scope covers the asking thread. That table is
 * the single source of truth: the wire `Settings.permissions` array is a
 * projection of it, not a second place rules can live.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { InteractionMode, RuntimeMode } from "@poseidon/contracts/enums";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import type { PermissionRule, PermissionScope } from "@poseidon/contracts/settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { layer as migrationsLayer } from "../persistence/Migrations";

import { parsePattern, matchPattern, requestCommand, requestPath, requestUrl } from "./patterns";
import { commandTouchesSensitivePath, isSensitivePath } from "./sensitivePaths";

/**
 * The local path a `file:` URL names, or `null` for anything else. A tool that
 * takes a URL can read a file just as surely as one that takes a path.
 */
const localPathOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : null;
  } catch {
    return null;
  }
};

/**
 * Whether the request touches credentials or key material — a file path for
 * the file kinds, any argument of the command line for `command`, and the
 * path or `file:` URL of anything else that names one.
 *
 * The last clause is what makes the contract's own words about `full-access`
 * true: "allows everything except sensitive paths and deny rules". Every
 * Poseidon MCP tool is classified `mcp_tool`, so the check used to skip them
 * entirely and the ladder fell through to `allow` — `browser_open` with a
 * `file:` URL followed by `browser_get text body` read `~/.ssh/id_ed25519`
 * with no card ever shown, where `read_file` on the same path prompts.
 */
const touchesSensitivePath = (request: ApprovalRequest, workspaceRoot?: string): boolean => {
  if (request.kind === "file_read" || request.kind === "file_write") {
    const path = requestPath(request);
    return path !== null && isSensitivePath(path, workspaceRoot);
  }
  if (request.kind === "command") {
    const command = requestCommand(request);
    return command !== null && commandTouchesSensitivePath(command, workspaceRoot);
  }
  const url = requestUrl(request);
  const fromUrl = url === null ? null : localPathOf(url);
  if (fromUrl !== null && isSensitivePath(fromUrl, workspaceRoot)) {
    return true;
  }
  const path = requestPath(request);
  return path !== null && isSensitivePath(path, workspaceRoot);
};

export type PermissionDecision = "allow" | "prompt" | "deny";

interface RuleRow {
  readonly scope: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly pattern: string;
  readonly decision: string;
  readonly created_at: string;
}

export interface DecideInput {
  readonly request: ApprovalRequest;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  /** Rules whose scope already covers this request. */
  readonly rules: ReadonlyArray<Pick<PermissionRule, "pattern" | "decision">>;
  /**
   * The thread's workspace root: its worktree, or its project's directory.
   * Directories above it are where the user keeps the project, so they do not
   * make its files sensitive.
   */
  readonly workspaceRoot?: string;
}

/** The pure ladder — everything a decision needs is an argument. */
export const decidePermission = (input: DecideInput): PermissionDecision => {
  const { request, runtimeMode, interactionMode, rules, workspaceRoot } = input;

  const compiled = rules.flatMap((rule) => {
    const parsed = parsePattern(rule.pattern);
    return parsed === null ? [] : [{ parsed, decision: rule.decision }];
  });
  const matching = compiled.filter((rule) => matchPattern(rule.parsed, request));

  if (matching.some((rule) => rule.decision === "deny")) {
    return "deny";
  }
  if (interactionMode === "plan" && request.kind !== "file_read") {
    return "deny";
  }
  if (touchesSensitivePath(request, workspaceRoot)) {
    return "prompt";
  }
  if (matching.some((rule) => rule.decision === "allow")) {
    return "allow";
  }
  if (request.kind === "file_read") {
    return "allow";
  }
  switch (runtimeMode) {
    case "approval-required":
      return "prompt";
    case "auto-accept-edits":
      return request.kind === "file_write" ? "allow" : "prompt";
    case "full-access":
      return "allow";
  }
};

// ── The rules table ───────────────────────────────────────────
//
// `permission_rules` is the single source of truth for permissions: the
// approval flow appends to it ("allow always"), the ladder reads it on every
// tool call, and the wire `Settings.permissions` array is a projection of it
// rather than a second store. The functions below are the table's whole API,
// taken as plain SqlClient effects so the settings document can project them
// without pulling the service into its layer graph.

/**
 * The reactivity key that says "the rules table changed".
 *
 * The settings document projects this table, and the two writers that append a
 * rule — `addRule` here and the engine's own insert behind an "allow always"
 * approval — go straight to SQL without passing through `SettingsStore.update`.
 * Without a signal an open settings page kept showing the list as it was when
 * it loaded. Those writers invalidate this key; `SettingsStore.changes`
 * subscribes to it and re-reads.
 *
 * `writeRules` deliberately does not: its only caller is `SettingsStore.update`,
 * which already emits the new document itself, and invalidating mid-transaction
 * would emit the *pre-update* settings just before it.
 *
 * @public
 */
export const PERMISSION_RULES_KEY = "permission_rules";

const toRule = (row: RuleRow): PermissionRule => ({
  scope: row.scope as PermissionScope,
  ...(row.project_id === "" ? {} : { projectId: row.project_id as ProjectId }),
  ...(row.thread_id === "" ? {} : { threadId: row.thread_id as ThreadId }),
  pattern: row.pattern,
  decision: row.decision as "allow" | "deny",
  createdAt: row.created_at,
});

/** Every stored rule, in insertion order. The listing `Settings` projects. */
export const readRules = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<PermissionRule>, SqlError> =>
  sql<RuleRow>`
    SELECT scope, project_id, thread_id, pattern, decision, created_at
    FROM permission_rules
    ORDER BY rule_id
  `.pipe(Effect.map((rows) => rows.map(toRule)));

/**
 * Replaces the whole table with `rules` — what a settings update that carries
 * a `permissions` array means. Editing the list in the UI is a whole-document
 * operation, so anything the user removed has to disappear here too.
 */
export const writeRules = (
  sql: SqlClient.SqlClient,
  rules: ReadonlyArray<PermissionRule>,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM permission_rules`;
    for (const rule of rules) {
      yield* insertRule(sql, rule);
    }
  });

const insertRule = (
  sql: SqlClient.SqlClient,
  rule: Pick<PermissionRule, "scope" | "pattern" | "decision"> & {
    readonly projectId?: ProjectId;
    readonly threadId?: ThreadId;
    readonly createdAt?: string;
  },
): Effect.Effect<void, SqlError> =>
  sql`
    INSERT INTO permission_rules
      (scope, project_id, thread_id, pattern, decision, created_at)
    VALUES (
      ${rule.scope}, ${rule.projectId ?? ""}, ${rule.threadId ?? ""},
      ${rule.pattern}, ${rule.decision}, ${rule.createdAt ?? new Date().toISOString()}
    )
    ON CONFLICT (scope, project_id, thread_id, pattern) DO UPDATE SET
      decision = excluded.decision,
      created_at = excluded.created_at
  `.pipe(Effect.asVoid);

/** @public Consumed by the RPC layer once wired. */
export class PermissionService extends Context.Service<
  PermissionService,
  {
    /**
     * The decision for a request, given the thread's modes and every rule whose
     * scope covers it — global rules, the project's rules, the session's.
     */
    readonly decide: (input: {
      readonly request: ApprovalRequest;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: InteractionMode;
      readonly projectId?: ProjectId;
      readonly threadId?: ThreadId;
      /** The thread's directory — see `DecideInput.workspaceRoot`. */
      readonly workspaceRoot?: string;
    }) => Effect.Effect<PermissionDecision, SqlError>;
    readonly rules: (
      scope?: PermissionScope,
      projectId?: ProjectId,
      threadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PermissionRule>, SqlError>;
    readonly addRule: (
      rule: Pick<PermissionRule, "scope" | "pattern" | "decision"> & {
        readonly projectId?: ProjectId;
        readonly threadId?: ThreadId;
      },
    ) => Effect.Effect<void, SqlError>;
  }
>()("server/permissions/PermissionService") {
  static readonly layer = Layer.effect(
    PermissionService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Held rather than required per call, so `addRule` keeps the plain
      // `Effect<void, SqlError>` its callers (and their test doubles) declare.
      const reactivity = yield* Reactivity.Reactivity;

      /** The listing API: an argument given is an exact filter. */
      const rules = (scope?: PermissionScope, projectId?: ProjectId, threadId?: ThreadId) =>
        sql<RuleRow>`
          SELECT scope, project_id, thread_id, pattern, decision, created_at
          FROM permission_rules
          WHERE (${scope ?? ""} = '' OR scope = ${scope ?? ""})
            AND (${projectId ?? ""} = '' OR project_id = ${projectId ?? ""})
            AND (${threadId ?? ""} = '' OR thread_id = ${threadId ?? ""})
          ORDER BY rule_id
        `.pipe(Effect.map((rows) => rows.map(toRule)));

      /**
       * The rules whose scope covers one asking thread: global rules, plus the
       * rules of exactly this project and exactly this thread. A rule that
       * names a project or a thread the caller did not supply does not apply —
       * the old predicate kept it, so a decide() without a thread id inherited
       * every other thread's "allow for this session".
       */
      const applicableRules = (projectId?: ProjectId, threadId?: ThreadId) =>
        sql<RuleRow>`
          SELECT scope, project_id, thread_id, pattern, decision, created_at
          FROM permission_rules
          WHERE (project_id = '' OR project_id = ${projectId ?? ""})
            AND (thread_id = '' OR thread_id = ${threadId ?? ""})
          ORDER BY rule_id
        `.pipe(Effect.map((rows) => rows.map(toRule)));

      return PermissionService.of({
        decide: (input) =>
          Effect.map(applicableRules(input.projectId, input.threadId), (applicable) =>
            decidePermission({
              request: input.request,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              rules: applicable,
              ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            }),
          ),
        rules,
        // "Allow always" lands here and in the engine's own insert; both tell
        // the settings document its projection is stale.
        addRule: (rule) =>
          Effect.tap(insertRule(sql, rule), () => reactivity.invalidate([PERMISSION_RULES_KEY])),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}
