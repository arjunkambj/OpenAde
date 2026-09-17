/**
 * The persisted settings document and the defaults a fresh install starts from.
 *
 * Settings are server-owned: the renderer reads them over RPC and patches them
 * over RPC, so a change made in one window shows up in the other. Every field
 * the settings pages render carries a `settingsForm` key annotation describing
 * how to render it — label, help text, control — which keeps the form and the
 * schema from drifting apart as fields are added.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString } from "./base";
import { DEFAULT_RUNTIME_MODE, Effort, RuntimeMode } from "./enums";
import { CMD_CONNECTOR_KIND, ConnectorInstanceId, ConnectorKind, ProjectId, ThreadId } from "./ids";

/** How one settings field is presented. Read by the settings pages, never by the server. */
export interface SettingsFormField {
  readonly label: string;
  readonly description?: string;
  readonly control: "text" | "path" | "select" | "toggle" | "keyValue" | "shortcut" | "hidden";
  readonly placeholder?: string;
}

/**
 * Attaches a `settingsForm` annotation to the field a schema is used as. The
 * returned function stays generic so that piping through it preserves the
 * schema's own type, optionality included.
 */
const settingsForm =
  (field: SettingsFormField) =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotateKey({ settingsForm: field });

// ── Connector configuration ────────────────────────────────────

/**
 * Command Code's own knobs. `binaryPath` is empty until the user overrides the
 * probe, `extraEnv` is merged into the allowlisted spawn environment, and
 * `defaultModel` seeds new threads on this instance.
 */
export const CmdConnectorConfig = Schema.Struct({
  binaryPath: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Binary path",
      description: "Path to the cmd binary. Leave empty to use the discovered one.",
      control: "path",
      placeholder: "cmd",
    }),
  ),
  extraEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)).pipe(
    settingsForm({
      label: "Extra environment",
      description: "Variables added to every session this instance spawns.",
      control: "keyValue",
    }),
  ),
  defaultModel: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Default model",
      description: "Model new threads on this instance start with.",
      control: "select",
    }),
  ),
});
export type CmdConnectorConfig = typeof CmdConnectorConfig.Type;

/**
 * kind → the connector's config schema and the name to offer it under. The
 * settings form renders `schema.fields` through their `settingsForm`
 * annotations, so a connector's page needs zero connector-specific markup —
 * registering a schema here is all a new connector needs on the render side.
 * (The server-side definition validates `unknown` config through this schema.)
 */
export interface ConnectorConfigSchemaEntry {
  readonly displayName: string;
  readonly schema: Schema.Struct<Schema.Struct.Fields>;
}

export const CONNECTOR_CONFIG_SCHEMAS: Readonly<Record<ConnectorKind, ConnectorConfigSchemaEntry>> =
  {
    [CMD_CONNECTOR_KIND]: { displayName: "Command Code", schema: CmdConnectorConfig },
  };

/** The config schema for a kind, when this build knows one. */
export const connectorConfigSchemaFor = (
  kind: ConnectorKind,
): Schema.Struct<Schema.Struct.Fields> | undefined => CONNECTOR_CONFIG_SCHEMAS[kind]?.schema;

/**
 * One configured connector. `config` is the connector's own settings document,
 * unmodelled here so that adding a connector does not widen this union —
 * the connector's definition owns its schema and validates it on load.
 */
export const ConnectorInstanceConfig = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId.pipe(
    settingsForm({ label: "Instance id", control: "hidden" }),
  ),
  kind: ConnectorKind.pipe(
    settingsForm({
      label: "Connector",
      description: "Which harness this instance runs.",
      control: "select",
    }),
  ),
  displayName: NonEmptyString.pipe(
    settingsForm({
      label: "Name",
      description: "How this instance is listed in the model picker.",
      control: "text",
    }),
  ),
  enabled: Schema.Boolean.pipe(
    settingsForm({
      label: "Enabled",
      description: "Disabled instances stay configured but start no sessions.",
      control: "toggle",
    }),
  ),
  config: Schema.Unknown.pipe(settingsForm({ label: "Connector settings", control: "hidden" })),
});
export type ConnectorInstanceConfig = typeof ConnectorInstanceConfig.Type;

// ── Permissions ────────────────────────────────────────────────

/** How far a permission rule reaches. */
export const PermissionScope = Schema.Literals(["global", "project", "session"]);
export type PermissionScope = typeof PermissionScope.Type;

/**
 * One persisted permission rule, in Command Code's pattern syntax
 * (`Shell(npm run *)`, `Edit(/src/**)`, `mcp__server__tool`). Deny wins over
 * ask, ask wins over allow, so a rule can only ever be made stricter by adding
 * another one. `projectId` and `threadId` narrow the rule to its scope.
 */
export const PermissionRule = Schema.Struct({
  scope: PermissionScope.pipe(
    settingsForm({
      label: "Scope",
      description: "Where this rule applies.",
      control: "select",
    }),
  ),
  projectId: Schema.optional(ProjectId).pipe(settingsForm({ label: "Project", control: "hidden" })),
  threadId: Schema.optional(ThreadId).pipe(settingsForm({ label: "Thread", control: "hidden" })),
  pattern: NonEmptyString.pipe(
    settingsForm({
      label: "Pattern",
      description: "Command Code pattern, e.g. Shell(git push:*) or Edit(/src/**).",
      control: "text",
      placeholder: "Shell(npm run *)",
    }),
  ),
  decision: Schema.Literals(["allow", "deny"]).pipe(
    settingsForm({ label: "Decision", control: "select" }),
  ),
  createdAt: IsoDateTime.pipe(settingsForm({ label: "Created", control: "hidden" })),
});
export type PermissionRule = typeof PermissionRule.Type;

// ── Keybindings ────────────────────────────────────────────────

/**
 * One shortcut. `command` is the action id the renderer dispatches; `shortcut`
 * is the chord in the table's own notation (`Cmd+Shift+B`), normalised per
 * platform at the point of use. `when` narrows a binding to a context, the way
 * VS Code's `when` clauses do.
 */
export const Keybinding = Schema.Struct({
  command: NonEmptyString.pipe(settingsForm({ label: "Command", control: "hidden" })),
  shortcut: NonEmptyString.pipe(settingsForm({ label: "Shortcut", control: "shortcut" })),
  when: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "When",
      description: "Context this binding applies in.",
      control: "text",
    }),
  ),
});
export type Keybinding = typeof Keybinding.Type;

/**
 * The server-owned defaults. The keybindings page shows these as the baseline a
 * user's overrides are diffed against, so the list is the contract, not a
 * renderer constant.
 */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = [
  { command: "thread.new", shortcut: "Cmd+N" },
  { command: "commandPalette.toggle", shortcut: "Cmd+K" },
  { command: "composer.queue", shortcut: "Cmd+Enter" },
  { command: "thread.interrupt", shortcut: "Escape" },
  { command: "browserPane.toggle", shortcut: "Cmd+Shift+B" },
];

// ── The document ───────────────────────────────────────────────

/** Follow the OS, or pin one appearance. */
export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;

/**
 * What a new thread starts with. `model` is null until a connector has been
 * probed and reported its models — writing a guessed model id here would make
 * the first turn fail in a way the user cannot read.
 */
export const SettingsDefaults = Schema.Struct({
  model: Schema.NullOr(NonEmptyString).pipe(
    settingsForm({
      label: "Default model",
      description: "Model new threads start with.",
      control: "select",
    }),
  ),
  effort: Effort.pipe(
    settingsForm({
      label: "Default effort",
      description: "Reasoning effort new threads start with, where the model accepts one.",
      control: "select",
    }),
  ),
  runtimeMode: RuntimeMode.pipe(
    settingsForm({
      label: "Default runtime mode",
      description: "How much a new thread may do before asking.",
      control: "select",
    }),
  ),
});
export type SettingsDefaults = typeof SettingsDefaults.Type;

export const Settings = Schema.Struct({
  connectors: Schema.Array(ConnectorInstanceConfig).pipe(
    settingsForm({ label: "Connectors", control: "hidden" }),
  ),
  defaults: SettingsDefaults.pipe(settingsForm({ label: "Defaults", control: "hidden" })),
  theme: Theme.pipe(
    settingsForm({ label: "Theme", description: "Appearance.", control: "select" }),
  ),
  keybindings: Schema.Array(Keybinding).pipe(
    settingsForm({ label: "Keybindings", control: "hidden" }),
  ),
  permissions: Schema.Array(PermissionRule).pipe(
    settingsForm({ label: "Permission rules", control: "hidden" }),
  ),
});
export type Settings = typeof Settings.Type;

/** A partial settings update. Absent fields are left as they are. */
export const SettingsPatch = Schema.Struct({
  connectors: Schema.optional(Schema.Array(ConnectorInstanceConfig)),
  defaults: Schema.optional(SettingsDefaults),
  theme: Schema.optional(Theme),
  keybindings: Schema.optional(Schema.Array(Keybinding)),
  permissions: Schema.optional(Schema.Array(PermissionRule)),
});
export type SettingsPatch = typeof SettingsPatch.Type;

/**
 * The document a fresh install writes. No connectors are configured yet, so no
 * model is chosen, and the runtime mode is the one that asks before acting.
 */
export const defaultSettings = (): Settings => ({
  connectors: [],
  defaults: { model: null, effort: "medium", runtimeMode: DEFAULT_RUNTIME_MODE },
  theme: "system",
  keybindings: DEFAULT_KEYBINDINGS,
  permissions: [],
});
