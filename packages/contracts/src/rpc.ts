/**
 * The one RPC surface between the renderer and the server.
 *
 * Everything the client can ask for is here, as a single `RpcGroup` carried
 * over a WebSocket with JSON serialization. Reads that have to stay fresh are
 * streams rather than polls, and every stream can end in
 * `resnapshot-required`: the server puts a budget on each subscription, so a
 * client that falls too far behind is told to start over instead of being fed
 * an ever-growing backlog.
 *
 * Commands do not appear as individual RPCs. `orchestration.dispatch` takes the
 * whole `Command` union, which is what keeps the decider the single place where
 * a state change is decided.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { Effort } from "./enums";
import { ConnectorInstanceId, ConnectorKind, ProjectId, ThreadId, UuidV7 } from "./ids";
import {
  Command,
  CommandReceipt,
  ProjectSummary,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "./orchestration";
import { ConnectorCapabilities, FileChangeKind } from "./runtime";
import { Keybinding, Settings, SettingsPatch } from "./settings";

// ── Errors ─────────────────────────────────────────────────────

/**
 * The single failure shape every RPC can return. `code` is what the client
 * switches on; `message` is what it shows. Anything the server does not
 * classify surfaces as a defect instead, which is the honest answer for a bug.
 */
export class OpenAdeRpcError extends Schema.TaggedError<OpenAdeRpcError>()("OpenAdeRpcError", {
  code: Schema.Literals(["not-found", "invalid", "unavailable", "conflict", "internal"]),
  message: Schema.String,
}) {}

// ── Payload and result schemas ─────────────────────────────────

/**
 * The first thing a client reads after connecting. `serverInstanceId` changes
 * when the server restarts, which is the signal for a reconnecting client to
 * throw away its cached snapshots rather than resume against state that no
 * longer exists.
 */
export const ServerHello = Schema.Struct({
  protocolVersion: NonNegativeInt,
  serverInstanceId: UuidV7,
});
export type ServerHello = typeof ServerHello.Type;

/** The protocol version this build speaks. Bumped when a wire shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/**
 * The server-side budget on every stream RPC (spec section 6).
 *
 * A subscription that exceeds either limit fails with `resnapshot-required`
 * rather than growing a backlog the client will never catch up with. The
 * numbers live here because both ends have to agree on them: the server
 * enforces them, the client's resubscribe logic expects them, and the
 * transfer-budget test asserts against them.
 */
export const STREAM_BUDGET_ITEMS = 1000;
export const STREAM_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * How long the server holds events back before flushing them as one frame.
 * Coalescing is what keeps a fast connector from turning every token into a
 * WebSocket message.
 */
export const STREAM_COALESCE_MS = 50;

/**
 * One entry in the model picker. `efforts` is the ladder this specific model
 * accepts, which is why `Effort` is a superset rather than a promise, and
 * `family` is the group header the connector's model list came under.
 */
export const ModelOption = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  family: NonEmptyString,
  efforts: Schema.Array(Effort),
  contextWindow: Schema.optional(NonNegativeInt),
  vision: Schema.optional(Schema.Boolean),
  free: Schema.optional(Schema.Boolean),
});
export type ModelOption = typeof ModelOption.Type;

/**
 * What happened when the server last went looking for a connector's CLI. The
 * connectors page renders this directly, so the failure states are named rather
 * than folded into a message string.
 */
export const ConnectorProbe = Schema.Struct({
  status: Schema.Literals(["ready", "not-installed", "not-authenticated", "error", "probing"]),
  binaryPath: Schema.optional(NonEmptyString),
  version: Schema.optional(NonEmptyString),
  /** Whether the harness reported usable credentials: present, absent, unknown. */
  auth: Schema.optional(Schema.Literals(["present", "absent", "unknown"])),
  /** The account the probe saw, e.g. the login email — for the settings page. */
  account: Schema.optional(Schema.String),
  /** How many models the probe reported — the settings page's "N models" line. */
  modelCount: Schema.optional(NonNegativeInt),
  /** A link that fixes what the probe found, e.g. the billing page on auth/credit failures. */
  helpUrl: Schema.optional(NonEmptyString),
  message: Schema.optional(Schema.String),
  probedAt: IsoDateTime,
});
export type ConnectorProbe = typeof ConnectorProbe.Type;

/**
 * Where an auth-or-credits probe failure is resolved. A connector's probe can
 * point `helpUrl` somewhere more specific; the renderer falls back here, which
 * is also what keeps the connector's own domain name out of `apps/web`.
 */
export const ACCOUNT_HELP_URL = "https://commandcode.ai/billing";

/** A configured connector as the settings page and the model picker see it. */
export const ConnectorSummary = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  kind: ConnectorKind,
  displayName: NonEmptyString,
  enabled: Schema.Boolean,
  capabilities: Schema.NullOr(ConnectorCapabilities),
  probe: ConnectorProbe,
});
export type ConnectorSummary = typeof ConnectorSummary.Type;

/** One hit from the composer's `@` file search. */
export const FileSearchResult = Schema.Struct({
  path: NonEmptyString,
  name: NonEmptyString,
  isDirectory: Schema.Boolean,
});
export type FileSearchResult = typeof FileSearchResult.Type;

/**
 * A file the client asked to read. `truncated` says the server stopped early —
 * the files pane shows a notice rather than pretending it has the whole file.
 */
export const FileContent = Schema.Struct({
  path: NonEmptyString,
  text: Schema.String,
  totalLines: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type FileContent = typeof FileContent.Type;

/** One path in `git status`, and whether its change is staged. */
export const GitFileChange = Schema.Struct({
  path: NonEmptyString,
  oldPath: Schema.optional(NonEmptyString),
  status: Schema.Literals(["added", "modified", "deleted", "renamed", "untracked"]),
  staged: Schema.Boolean,
});
export type GitFileChange = typeof GitFileChange.Type;

/**
 * `isRepository: false` is the answer for a workspace git does not track: the
 * empty `files` list then means "there is nothing to show", not "everything is
 * committed", and the changes pane can say so instead of rendering a clean
 * repo. It is optional so a producer that predates the field still decodes.
 */
export const GitStatus = Schema.Struct({
  branch: Schema.NullOr(NonEmptyString),
  upstream: Schema.NullOr(NonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  isRepository: Schema.optional(Schema.Boolean),
  files: Schema.Array(GitFileChange),
});
export type GitStatus = typeof GitStatus.Type;

/** One file's unified diff, with the counts the changes pane shows in the row. */
export const GitDiffFile = Schema.Struct({
  path: NonEmptyString,
  oldPath: Schema.optional(NonEmptyString),
  kind: FileChangeKind,
  diff: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitDiffFile = typeof GitDiffFile.Type;

/** `isRepository` carries the same meaning it does on `GitStatus`. */
export const GitDiff = Schema.Struct({
  from: Schema.NullOr(NonEmptyString),
  to: Schema.NullOr(NonEmptyString),
  isRepository: Schema.optional(Schema.Boolean),
  files: Schema.Array(GitDiffFile),
});
export type GitDiff = typeof GitDiff.Type;

/**
 * What the browser pane shows. `cdp-attach` drives the webview already embedded
 * in the dock, so there is no frame to ship; `owned-chromium` runs its own
 * browser and streams JPEG frames, which is why `frame` is nullable rather than
 * two separate state shapes.
 */
export const BrowserFrame = Schema.Struct({
  mediaType: NonEmptyString,
  base64: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
  capturedAt: IsoDateTime,
});
export type BrowserFrame = typeof BrowserFrame.Type;

export const BrowserState = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["stopped", "starting", "ready", "error"]),
  mode: Schema.Literals(["cdp-attach", "owned-chromium"]),
  url: Schema.NullOr(NonEmptyString),
  title: Schema.NullOr(Schema.String),
  frame: Schema.NullOr(BrowserFrame),
  /**
   * The `browser_*` tool currently executing, if one is — the pane's
   * "agent is driving" indicator. `null` once the call settles.
   */
  activeTool: Schema.optional(Schema.NullOr(NonEmptyString)),
  message: Schema.optional(Schema.String),
});
export type BrowserState = typeof BrowserState.Type;

/** A person taking over the browser the agent is driving. */
export const BrowserHumanInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    key: NonEmptyString,
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["alt", "ctrl", "meta", "shift"]))),
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    deltaX: Schema.Number,
    deltaY: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("navigate"), url: NonEmptyString }),
  /** Toolbar back/forward/reload — a human gesture that interrupts the agent. */
  Schema.Struct({
    kind: Schema.Literal("history"),
    direction: Schema.Literals(["back", "forward", "reload"]),
  }),
  /**
   * Passive location sync: the pane observed a navigation (whoever caused it)
   * and reports where the page actually is. Never marks human control.
   */
  Schema.Struct({
    kind: Schema.Literal("location"),
    url: NonEmptyString,
    title: Schema.optional(Schema.String),
  }),
]);
export type BrowserHumanInput = typeof BrowserHumanInput.Type;

/** Where an MCP server entry is written in Command Code's own config. */
export const McpServerScope = Schema.Literals(["user", "project"]);
export type McpServerScope = typeof McpServerScope.Type;

/**
 * One MCP server, in the shape Command Code's `mcp.json` stores. `${VAR}`
 * references in headers and env are resolved at spawn time, so a per-session
 * bearer never reaches disk.
 */
export const McpServerConfig = Schema.Struct({
  name: NonEmptyString,
  scope: McpServerScope,
  enabled: Schema.Boolean,
  /**
   * Read-side hint: `true` when the entry carries our `_openade` marker, so
   * the editor knows upsert/remove will be accepted. The server ignores it on
   * write — ownership is decided by the marker on disk, not by the payload.
   */
  managed: Schema.optional(Schema.Boolean),
  transport: Schema.Literals(["http", "stdio"]),
  url: Schema.optional(NonEmptyString),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  command: Schema.optional(NonEmptyString),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpServerConfig = typeof McpServerConfig.Type;

/** One skill found under the connector's skills directory. */
export const SkillSummary = Schema.Struct({
  name: NonEmptyString,
  path: NonEmptyString,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});
export type SkillSummary = typeof SkillSummary.Type;

// ── Method names ───────────────────────────────────────────────

/** Every RPC method name in one place, so a rename is a single edit. */
export const RPC_METHODS = {
  serverHello: "server.hello",
  orchestrationDispatch: "orchestration.dispatch",
  projectsList: "projects.list",
  threadsList: "threads.list",
  threadsSubscribe: "threads.subscribe",
  threadsListSubscribe: "threads.listSubscribe",
  connectorsList: "connectors.list",
  connectorsModels: "connectors.models",
  filesSearch: "files.search",
  filesRead: "files.read",
  gitStatus: "git.status",
  gitDiff: "git.diff",
  browserSubscribe: "browser.subscribe",
  browserHumanInput: "browser.humanInput",
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
  settingsSubscribe: "settings.subscribe",
  cmdConfigMcpList: "cmdConfig.mcp.list",
  cmdConfigMcpUpsert: "cmdConfig.mcp.upsert",
  cmdConfigMcpRemove: "cmdConfig.mcp.remove",
  cmdConfigSkillsList: "cmdConfig.skills.list",
  keybindingsGet: "keybindings.get",
  keybindingsUpdate: "keybindings.update",
} as const;

// ── The RPCs ───────────────────────────────────────────────────

const empty = Schema.Struct({});

const ServerHelloRpc = Rpc.make(RPC_METHODS.serverHello, {
  payload: empty,
  success: ServerHello,
  error: OpenAdeRpcError,
});

const OrchestrationDispatchRpc = Rpc.make(RPC_METHODS.orchestrationDispatch, {
  payload: Schema.Struct({ command: Command }),
  success: CommandReceipt,
  error: OpenAdeRpcError,
});

const ProjectsListRpc = Rpc.make(RPC_METHODS.projectsList, {
  payload: empty,
  success: Schema.Array(ProjectSummary),
  error: OpenAdeRpcError,
});

const ThreadsListRpc = Rpc.make(RPC_METHODS.threadsList, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Array(ThreadSummary),
  error: OpenAdeRpcError,
});

/**
 * Subscribe to one thread. `afterSequence` is how a reconnecting client asks
 * for catch-up instead of a fresh snapshot; the server answers with
 * `resnapshot-required` when that position is no longer replayable.
 */
const ThreadsSubscribeRpc = Rpc.make(RPC_METHODS.threadsSubscribe, {
  payload: Schema.Struct({
    threadId: ThreadId,
    afterSequence: Schema.optional(NonNegativeInt),
  }),
  success: ThreadStreamItem,
  error: OpenAdeRpcError,
  stream: true,
});

const ThreadsListSubscribeRpc = Rpc.make(RPC_METHODS.threadsListSubscribe, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    afterSequence: Schema.optional(NonNegativeInt),
  }),
  success: ThreadListStreamItem,
  error: OpenAdeRpcError,
  stream: true,
});

/**
 * `refresh: true` re-runs each configured connector's probe before answering —
 * the settings page's probe button. The default returns the probes cached by
 * the last reconcile, so listing stays cheap for the model picker.
 */
const ConnectorsListRpc = Rpc.make(RPC_METHODS.connectorsList, {
  payload: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
  success: Schema.Array(ConnectorSummary),
  error: OpenAdeRpcError,
});

const ConnectorsModelsRpc = Rpc.make(RPC_METHODS.connectorsModels, {
  payload: Schema.Struct({ instanceId: ConnectorInstanceId }),
  success: Schema.Array(ModelOption),
  error: OpenAdeRpcError,
});

const FilesSearchRpc = Rpc.make(RPC_METHODS.filesSearch, {
  payload: Schema.Struct({
    projectId: ProjectId,
    query: Schema.String,
    limit: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Array(FileSearchResult),
  error: OpenAdeRpcError,
});

const FilesReadRpc = Rpc.make(RPC_METHODS.filesRead, {
  payload: Schema.Struct({
    projectId: ProjectId,
    path: NonEmptyString,
    offset: Schema.optional(NonNegativeInt),
    limit: Schema.optional(NonNegativeInt),
  }),
  success: FileContent,
  error: OpenAdeRpcError,
});

const GitStatusRpc = Rpc.make(RPC_METHODS.gitStatus, {
  payload: Schema.Struct({ projectId: ProjectId }),
  success: GitStatus,
  error: OpenAdeRpcError,
});

/**
 * A diff of the worktree, or between two checkpoint refs. Omitting both ends
 * means "the working tree against HEAD", which is what the changes pane opens
 * on.
 */
const GitDiffRpc = Rpc.make(RPC_METHODS.gitDiff, {
  payload: Schema.Struct({
    projectId: ProjectId,
    from: Schema.optional(NonEmptyString),
    to: Schema.optional(NonEmptyString),
    path: Schema.optional(NonEmptyString),
  }),
  success: GitDiff,
  error: OpenAdeRpcError,
});

const BrowserSubscribeRpc = Rpc.make(RPC_METHODS.browserSubscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: BrowserState,
  error: OpenAdeRpcError,
  stream: true,
});

const BrowserHumanInputRpc = Rpc.make(RPC_METHODS.browserHumanInput, {
  payload: Schema.Struct({ threadId: ThreadId, input: BrowserHumanInput }),
  success: empty,
  error: OpenAdeRpcError,
});

const SettingsGetRpc = Rpc.make(RPC_METHODS.settingsGet, {
  payload: empty,
  success: Settings,
  error: OpenAdeRpcError,
});

const SettingsUpdateRpc = Rpc.make(RPC_METHODS.settingsUpdate, {
  payload: Schema.Struct({ patch: SettingsPatch }),
  success: Settings,
  error: OpenAdeRpcError,
});

const SettingsSubscribeRpc = Rpc.make(RPC_METHODS.settingsSubscribe, {
  payload: empty,
  success: Settings,
  error: OpenAdeRpcError,
  stream: true,
});

const CmdConfigMcpListRpc = Rpc.make(RPC_METHODS.cmdConfigMcpList, {
  payload: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: Schema.Array(McpServerConfig),
  error: OpenAdeRpcError,
});

const CmdConfigMcpUpsertRpc = Rpc.make(RPC_METHODS.cmdConfigMcpUpsert, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    server: McpServerConfig,
  }),
  success: Schema.Array(McpServerConfig),
  error: OpenAdeRpcError,
});

const CmdConfigMcpRemoveRpc = Rpc.make(RPC_METHODS.cmdConfigMcpRemove, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    scope: McpServerScope,
    name: NonEmptyString,
  }),
  success: Schema.Array(McpServerConfig),
  error: OpenAdeRpcError,
});

const CmdConfigSkillsListRpc = Rpc.make(RPC_METHODS.cmdConfigSkillsList, {
  payload: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: Schema.Array(SkillSummary),
  error: OpenAdeRpcError,
});

const KeybindingsGetRpc = Rpc.make(RPC_METHODS.keybindingsGet, {
  payload: empty,
  success: Schema.Array(Keybinding),
  error: OpenAdeRpcError,
});

const KeybindingsUpdateRpc = Rpc.make(RPC_METHODS.keybindingsUpdate, {
  payload: Schema.Struct({ keybindings: Schema.Array(Keybinding) }),
  success: Schema.Array(Keybinding),
  error: OpenAdeRpcError,
});

export const OpenAdeRpcGroup = RpcGroup.make(
  ServerHelloRpc,
  OrchestrationDispatchRpc,
  ProjectsListRpc,
  ThreadsListRpc,
  ThreadsSubscribeRpc,
  ThreadsListSubscribeRpc,
  ConnectorsListRpc,
  ConnectorsModelsRpc,
  FilesSearchRpc,
  FilesReadRpc,
  GitStatusRpc,
  GitDiffRpc,
  BrowserSubscribeRpc,
  BrowserHumanInputRpc,
  SettingsGetRpc,
  SettingsUpdateRpc,
  SettingsSubscribeRpc,
  CmdConfigMcpListRpc,
  CmdConfigMcpUpsertRpc,
  CmdConfigMcpRemoveRpc,
  CmdConfigSkillsListRpc,
  KeybindingsGetRpc,
  KeybindingsUpdateRpc,
);
