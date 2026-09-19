/**
 * The settings-facing half of the renderer's atom runtime.
 *
 * `@/state/app-runtime` owns the one `makeRuntime` instance (and the offline
 * layer that keeps atoms mountable without a server). This module adds the
 * query/mutation atoms the settings pages and the welcome flow need that the
 * shared client runtime does not carry, built once on top of that instance.
 * Atoms the shared runtime already publishes — `skillsAtom`,
 * `connectorModelsAtom`, `keybindingsAtom`, `keybindingsUpdateAtom` — are
 * re-exported through the same bag rather than redefined here.
 */

import { Connection } from "@OpenAde/client-runtime/connection";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type {
  AgentSkill,
  McpServerConfig,
  McpServerScope,
  ModelOption,
} from "@OpenAde/contracts/rpc";
import type { SettingsPatch } from "@OpenAde/contracts/settings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { isObject, isString } from "effect/Predicate";
import * as Atom from "effect/unstable/reactivity/Atom";

import { getAppAtoms, type AppAtoms as BaseAppAtoms } from "@/state/app-runtime";

/** The message a failed `useAtomSet(..., { mode: "promiseExit" })` call should show. */
export const describeExitError = (exit: Exit.Exit<unknown, unknown>, fallback: string): string => {
  if (exit._tag !== "Failure") {
    return fallback;
  }
  const squashed = Cause.squash(exit.cause);
  return isObject(squashed) && "message" in squashed && isString(squashed.message)
    ? squashed.message
    : fallback;
};

const makeSettingsAtoms = (base: BaseAppAtoms) => {
  const { runtime } = base;

  /** The live RPC client — reconnects resolve to the fresh one underneath. */
  const client = Effect.flatMap(Connection, (conn) => conn.client);

  const settingsUpdateAtom = runtime.fn((patch: SettingsPatch) =>
    Effect.flatMap(client, (c) => c["settings.update"]({ patch })),
  );

  /**
   * The settings page's probe button: `refresh: true` re-runs every probe
   * server-side, then the list atom reloads so the page shows the outcome.
   */
  const probeConnectorsAtom = runtime.fn((_: void, get) =>
    Effect.gen(function* () {
      const list = yield* Effect.flatMap(client, (c) => c["connectors.list"]({ refresh: true }));
      get.registry.refresh(base.connectorsAtom);
      return list;
    }),
  );

  /** MCP servers for a project — `null` lists user scope only. */
  const mcpServersAtom = Atom.family((projectId: ProjectId | null) =>
    runtime.atom(
      Effect.flatMap(client, (c) =>
        c["cmdConfig.mcp.list"](projectId === null ? {} : { projectId }),
      ),
      { initialValue: [] as ReadonlyArray<McpServerConfig> },
    ),
  );

  const mcpUpsertAtom = runtime.fn(
    (input: { projectId: ProjectId | null; server: McpServerConfig }, get) =>
      Effect.gen(function* () {
        const next = yield* Effect.flatMap(client, (c) =>
          c["cmdConfig.mcp.upsert"]({
            ...(input.projectId === null ? {} : { projectId: input.projectId }),
            server: input.server,
          }),
        );
        get.registry.refresh(mcpServersAtom(input.projectId));
        return next;
      }),
  );

  const mcpRemoveAtom = runtime.fn(
    (input: { projectId: ProjectId | null; scope: McpServerScope; name: string }, get) =>
      Effect.gen(function* () {
        const next = yield* Effect.flatMap(client, (c) =>
          c["cmdConfig.mcp.remove"]({
            ...(input.projectId === null ? {} : { projectId: input.projectId }),
            scope: input.scope,
            name: input.name,
          }),
        );
        get.registry.refresh(mcpServersAtom(input.projectId));
        return next;
      }),
  );

  /** Skills in the shared agents folder the connector does not load yet. */
  const agentSkillsAtom = runtime.atom(
    Effect.flatMap(client, (c) => c["cmdConfig.skills.agents"]({})),
    { initialValue: [] as ReadonlyArray<AgentSkill> },
  );

  /**
   * Links one agents-folder skill into the global skills root. `projectId` is
   * the scope on screen, whose skills list now includes it.
   */
  const skillsLinkAtom = runtime.fn((input: { entry: string; projectId: ProjectId | null }, get) =>
    Effect.gen(function* () {
      const next = yield* Effect.flatMap(client, (c) =>
        c["cmdConfig.skills.link"]({ entry: input.entry }),
      );
      get.registry.refresh(agentSkillsAtom);
      get.registry.refresh(base.skillsAtom(input.projectId));
      return next;
    }),
  );

  /**
   * Every model every enabled instance advertises — the default-model picker
   * on the Models page. `family` carries the instance name so duplicates
   * across connectors stay distinct.
   */
  const allModelsAtom = runtime.atom(
    Effect.gen(function* () {
      const c = yield* client;
      const summaries = yield* c["connectors.list"]({});
      const perInstance = yield* Effect.forEach(
        summaries.filter((summary) => summary.enabled),
        (summary) =>
          c["connectors.models"]({ instanceId: summary.connectorInstanceId }).pipe(
            Effect.map((models) =>
              models.map((model): ModelOption => ({ ...model, family: summary.displayName })),
            ),
            Effect.orElseSucceed((): ReadonlyArray<ModelOption> => []),
          ),
      );
      return perInstance.flat();
    }),
    { initialValue: [] as ReadonlyArray<ModelOption> },
  );

  return {
    ...base,
    settingsUpdateAtom,
    probeConnectorsAtom,
    mcpServersAtom,
    mcpUpsertAtom,
    mcpRemoveAtom,
    agentSkillsAtom,
    skillsLinkAtom,
    allModelsAtom,
  };
};

export type AppAtoms = ReturnType<typeof makeSettingsAtoms>;

let appAtoms: AppAtoms | null = null;

/**
 * The bootstrapped atoms. `installAppAtoms` runs in `main.tsx` before the
 * router mounts, so by the time a component calls this the base bag exists.
 */
export const useAppAtoms = (): AppAtoms => {
  appAtoms ??= makeSettingsAtoms(getAppAtoms());
  return appAtoms;
};
