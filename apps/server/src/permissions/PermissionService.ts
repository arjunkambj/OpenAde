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
 * filtered to the rules whose scope covers the asking thread.
 */

import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { InteractionMode, RuntimeMode } from "@OpenAde/contracts/enums";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import type { PermissionRule, PermissionScope } from "@OpenAde/contracts/settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { layer as migrationsLayer } from "../persistence/Migrations";

import { parsePattern, matchPattern, requestCommand, requestPath } from "./patterns";
import { commandTouchesSensitivePath, isSensitivePath } from "./sensitivePaths";

/**
 * Whether the request touches credentials or key material — a file path for
 * the file kinds, any argument of the command line for `command`.
 */
const touchesSensitivePath = (request: ApprovalRequest): boolean => {
  if (request.kind === "file_read" || request.kind === "file_write") {
    const path = requestPath(request);
    return path !== null && isSensitivePath(path);
  }
  if (request.kind === "command") {
    const command = requestCommand(request);
    return command !== null && commandTouchesSensitivePath(command);
  }
  return false;
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
}

/** The pure ladder — everything a decision needs is an argument. */
export const decidePermission = (input: DecideInput): PermissionDecision => {
  const { request, runtimeMode, interactionMode, rules } = input;

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
  if (touchesSensitivePath(request)) {
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

      const toRule = (row: RuleRow): PermissionRule => ({
        scope: row.scope as PermissionScope,
        ...(row.project_id === "" ? {} : { projectId: row.project_id as ProjectId }),
        ...(row.thread_id === "" ? {} : { threadId: row.thread_id as ThreadId }),
        pattern: row.pattern,
        decision: row.decision as "allow" | "deny",
        createdAt: row.created_at,
      });

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
            }),
          ),
        rules,
        addRule: (rule) =>
          sql`
            INSERT INTO permission_rules
              (scope, project_id, thread_id, pattern, decision, created_at)
            VALUES (
              ${rule.scope}, ${rule.projectId ?? ""}, ${rule.threadId ?? ""},
              ${rule.pattern}, ${rule.decision}, ${new Date().toISOString()}
            )
            ON CONFLICT (scope, project_id, thread_id, pattern) DO UPDATE SET
              decision = excluded.decision,
              created_at = excluded.created_at
          `.pipe(Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}
