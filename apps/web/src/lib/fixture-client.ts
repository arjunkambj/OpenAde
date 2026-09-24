/**
 * The `/dev/composer` fixture: a `Connection` layer over an in-process fake
 * whose `orchestration.dispatch` runs a tiny decider — `approval.respond`
 * emits `approval.resolved`, `turn.start` emits `message.queued` or
 * `turn.requested`, the user's `item.upserted` row and `turn.started`, and so
 * on — so the cards, the queue strip and the sent bubbles exercise the real
 * round trip: the UI changes only when the event lands on the subscription,
 * never optimistically.
 *
 * `fixture.emit(type, payload)` folds the event into the fixture's doc and
 * pushes it onto the stream, which is how the page's scenario buttons drive
 * states the server would normally produce (a mid-turn approval, a plan, a
 * question). `fixture.onCommand` is the page's dispatch log.
 * `fixture.setSteering` flips the connector's `steering` capability and
 * rebinds the fixture session with it, as the server copies capabilities onto
 * `thread.session.bound`, so the composer's steer state can be seen; the page
 * refreshes `connectors.list`.
 */

import { applyThreadStreamItem } from "@OpenAde/client-runtime/clientState";
import type { ConnectionLayer } from "@OpenAde/client-runtime/atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "@OpenAde/client-runtime/connection";
import type {
  Command,
  CommandReceipt,
  OrchestrationEvent,
  OrchestrationEventType,
  ThreadDetailSnapshot,
  ThreadStreamItem,
} from "@OpenAde/contracts/orchestration";
import {
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { ConnectorInstanceId, ProjectId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import { OpenAdeRpcError, PROTOCOL_VERSION } from "@OpenAde/contracts/rpc";
import type {
  ConnectorDescriptor,
  ConnectorSummary,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "@OpenAde/contracts/connectors";
import type { FileSearchResult } from "@OpenAde/contracts/rpc";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";
import { defaultSettings } from "@OpenAde/contracts/settings";
import type { Keybinding } from "@OpenAde/contracts/settings";
import { uuidV7 } from "@OpenAde/shared/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

type EventPayload<T extends OrchestrationEventType> = Extract<
  OrchestrationEvent,
  { type: T }
>["payload"];

// ── Inline fixture data ────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";

const FIXTURE_FILES: ReadonlyArray<FileSearchResult> = [
  { path: "src/app.tsx", name: "app.tsx", isDirectory: false },
  { path: "src/components/composer.tsx", name: "composer.tsx", isDirectory: false },
  { path: "src/routes", name: "routes", isDirectory: true },
  { path: "docs/architecture.md", name: "architecture.md", isDirectory: false },
  { path: "packages/contracts/src/orchestration.ts", name: "orchestration.ts", isDirectory: false },
  { path: "package.json", name: "package.json", isDirectory: false },
];

const FIXTURE_MODELS: ReadonlyArray<ModelOption> = [
  {
    id: "fixture/flagship",
    label: "Flagship",
    family: "fixture",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 200000,
  },
  {
    id: "fixture/mid",
    label: "Mid",
    family: "fixture",
    efforts: ["low", "medium", "high"],
    contextWindow: 200000,
  },
  {
    id: "fixture/small",
    label: "Small",
    family: "fixture",
    efforts: ["low", "medium"],
  },
];

const FIXTURE_SKILLS: ReadonlyArray<SkillSummary> = [
  {
    name: "commit",
    path: "skills/commit.md",
    description: "Write a commit message",
    enabled: true,
  },
  {
    name: "review",
    path: "skills/review.md",
    description: "Review the current diff",
    enabled: true,
  },
  {
    // A paragraph, like most real skill descriptions: the menus must still
    // show the name beside it.
    name: "migrate-database",
    path: "skills/migrate-database.md",
    description:
      "Plan and run a database schema migration end to end: read the current schema, write the forward and backward migration files, run them against a scratch copy, compare row counts before and after, and report anything that would lock a large table for longer than a few seconds.",
    enabled: true,
  },
  ...["changelog", "deps-audit", "docs-sync", "flaky-tests", "perf-profile", "release"].map(
    (name): SkillSummary => ({
      name,
      path: `skills/${name}.md`,
      description: `The ${name} skill`,
      enabled: true,
    }),
  ),
  {
    name: "bench",
    path: "skills/bench.md",
    description: "Run the benchmark suite",
    enabled: false,
  },
];

/** The first fixture connector's plugins; the second carries no plugins extension. */
const FIXTURE_PLUGINS: ReadonlyArray<PluginSummary> = [
  {
    name: "formatter",
    description: "Format files after every edit",
    source: "fixture-marketplace",
    scope: "user",
    enabled: true,
  },
  {
    name: "release-notes",
    description: "Draft release notes from merged changes",
    source: "fixture-marketplace",
    scope: "project",
    enabled: true,
  },
];

const baseDoc = (
  threadId: ThreadId,
  projectId: ProjectId,
  connectorInstanceId: ConnectorInstanceId,
): ThreadDetailSnapshot => ({
  threadId,
  projectId,
  title: "fixture thread",
  status: "idle",
  settings: {
    model: "fixture/mid",
    effort: "medium",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  snapshotSequence: 0,
  items: [
    {
      itemId: makeItemId(),
      kind: "user_message",
      status: "completed",
      text: "Sketch the composer fixture states.",
    },
    {
      itemId: makeItemId(),
      kind: "assistant_message",
      status: "completed",
      text: "Working through them — every card and trigger lives below.",
    },
  ],
  queue: [],
  checkpoints: [],
  session: {
    connectorInstanceId,
    connectorKind: "fixture",
    sessionRef: { ref: "fixture" },
  },
  currentTurnId: null,
  pendingApproval: null,
  pendingUserInput: null,
  pendingPlan: null,
  usage: null,
  context: { used: 42000, limit: 200000 },
  createdAt: NOW,
  updatedAt: NOW,
});

/** The command fields the `thread.settings.update` event payload carries. */
const settingsPatch = (command: Extract<Command, { type: "thread.settings.update" }>) =>
  Object.fromEntries(
    [
      ["model", command.model],
      ["effort", command.effort],
      ["runtimeMode", command.runtimeMode],
      ["interactionMode", command.interactionMode],
      ["connectorInstanceId", command.connectorInstanceId],
    ].filter(([, value]) => value !== undefined),
  );

export interface FixtureClient {
  readonly layer: ConnectionLayer;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Emit an orchestration event: folds the fixture doc and pushes it to subscribers. */
  readonly emit: <T extends OrchestrationEventType>(type: T, payload: EventPayload<T>) => void;
  /** Push a non-event stream frame (`resnapshot-required`, a fresh snapshot). */
  readonly emitItem: (item: ThreadStreamItem) => void;
  /** Start a running turn, or return the running one's id. */
  readonly startTurn: () => TurnId;
  /** Settle the running turn: drain the queue, then `turn.completed`. */
  readonly completeTurn: () => void;
  /** The fixture's current doc — scenario buttons read pending fields from it. */
  readonly doc: () => ThreadDetailSnapshot;
  /** Whether the fixture connector reports that it can steer a running turn. */
  readonly steering: () => boolean;
  /**
   * Flip the steering capability: `connectors.list` answers the new value and
   * the session rebinds with it, since the composer steers by the session's.
   */
  readonly setSteering: (on: boolean) => void;
  /** Restore the base document and resnapshot. */
  readonly reset: () => void;
  /** Called after every dispatch — the page renders this as the command log. */
  onCommand: ((command: Command, receipt: CommandReceipt) => void) | undefined;
}

/** A 1x1 transparent PNG, for an attachment the fixture never really stored. */
const FIXTURE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const makeFixtureClient = (): FixtureClient => {
  /** What the page staged this session, keyed by the path it was given. */
  const fixtureAttachments = new Map<string, string>();
  const threadId = makeThreadId();
  const projectId = makeProjectId();
  const connectorInstanceId = makeConnectorInstanceId();
  const secondInstanceId = makeConnectorInstanceId();
  const serverInstanceId = uuidV7();

  const queue = Effect.runSync(Queue.unbounded<ThreadStreamItem>());
  let doc = baseDoc(threadId, projectId, connectorInstanceId);
  let streamVersion = 0;
  // The user's overrides, as the server stores them: none, so every default.
  let keybindings: ReadonlyArray<Keybinding> = [];
  let steering = false;
  let handle: FixtureClient;

  const offer = (item: ThreadStreamItem) => Effect.runSync(Queue.offer(queue, item));

  /** Build, fold and publish one event. */
  const next = <T extends OrchestrationEventType>(
    type: T,
    payload: EventPayload<T>,
    commandId?: Command["commandId"],
  ): void => {
    const event = {
      sequence: doc.snapshotSequence + 1,
      eventId: makeEventId(),
      streamKind: "thread" as const,
      streamId: threadId,
      streamVersion: ++streamVersion,
      occurredAt: new Date().toISOString(),
      // As on the server: the decider's events answer a command and carry
      // the user as actor; everything else arrives from the connector.
      actor: commandId === undefined ? ("connector" as const) : ("user" as const),
      ...(commandId === undefined ? {} : { commandId }),
      type,
      payload,
    } as OrchestrationEvent;
    doc = applyThreadStreamItem(doc, { kind: "event", event }) ?? doc;
    offer({ kind: "event", event });
  };

  const startTurn = (): TurnId => {
    const existing = doc.currentTurnId;
    if (existing !== null) {
      return existing;
    }
    const turnId = makeTurnId();
    next("thread.turn.requested", {
      turnId,
      text: "fixture turn",
      attachments: [],
      mentions: [],
    });
    next("thread.turn.started", { turnId });
    return turnId;
  };

  const completeTurn = (): void => {
    const turnId = doc.currentTurnId;
    if (turnId === null) {
      return;
    }
    for (const message of doc.queue) {
      next("thread.message.dequeued", { queuedMessageId: message.queuedMessageId, turnId });
    }
    next("thread.turn.completed", { turnId, stopReason: "end_turn" });
  };

  /**
   * The smallest honest decider for the commands the composer and cards send:
   * accept → the events a real engine would emit, reject → a reason string.
   */
  const decide = (command: Command): { events: () => void; reason?: string } => {
    switch (command.type) {
      case "thread.turn.start": {
        if (command.queued || doc.currentTurnId !== null) {
          return {
            events: () =>
              next("thread.message.queued", {
                message: {
                  queuedMessageId: makeItemId(),
                  text: command.text,
                  attachments: command.attachments,
                  mentions: command.mentions,
                  ...(command.references === undefined ? {} : { references: command.references }),
                  queuedAt: new Date().toISOString(),
                },
              }),
          };
        }
        return {
          events: () => {
            const turnId = makeTurnId();
            next("thread.turn.requested", {
              turnId,
              text: command.text,
              attachments: command.attachments,
              mentions: command.mentions,
              ...(command.references === undefined ? {} : { references: command.references }),
            });
            // The user's own row, minted beside the request as the server's
            // decider does, so the page can show the sent bubble.
            next("thread.item.upserted", {
              turnId,
              item: {
                itemId: makeItemId(),
                kind: "user_message",
                status: "completed",
                turnId,
                text: command.text,
                ...(command.attachments.length === 0 ? {} : { attachments: command.attachments }),
                ...(command.references === undefined ? {} : { references: command.references }),
              },
            });
            next("thread.turn.started", { turnId });
          },
        };
      }
      // As the server's decider: an idle steer starts a turn, a harness that
      // cannot steer is refused, and a steered message joins the running turn
      // as a user row stamped with it.
      case "thread.turn.steer": {
        const turnId = doc.currentTurnId;
        if (turnId === null) {
          return {
            events: () => {
              const started = makeTurnId();
              next("thread.turn.requested", {
                turnId: started,
                text: command.text,
                attachments: command.attachments,
                mentions: command.mentions,
              });
              next("thread.turn.started", { turnId: started });
            },
          };
        }
        if (!steering) {
          return {
            events: () => {},
            reason: "this thread's harness cannot take a message mid-turn; queue it instead",
          };
        }
        return {
          events: () => {
            const { text, attachments, mentions } = command;
            next("thread.turn.steered", { turnId, text, attachments, mentions }, command.commandId);
            next(
              "thread.item.upserted",
              {
                turnId,
                item: {
                  itemId: makeItemId(),
                  kind: "user_message",
                  status: "completed",
                  turnId,
                  text,
                },
              },
              command.commandId,
            );
          },
        };
      }
      case "thread.turn.interrupt": {
        const turnId = doc.currentTurnId;
        return turnId === null
          ? { events: () => {}, reason: "no turn is running" }
          : { events: () => next("thread.turn.interrupted", { turnId }) };
      }
      case "thread.approval.respond": {
        const pending = doc.pendingApproval;
        return pending === null || pending.requestId !== command.requestId
          ? { events: () => {}, reason: "no matching approval request" }
          : {
              events: () =>
                next(
                  "thread.approval.resolved",
                  {
                    requestId: command.requestId,
                    decision: command.decision,
                    ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.userInput.respond": {
        const pending = doc.pendingUserInput;
        return pending === null || pending.requestId !== command.requestId
          ? { events: () => {}, reason: "no matching question request" }
          : {
              events: () =>
                next(
                  "thread.userInput.resolved",
                  {
                    requestId: command.requestId,
                    answers: command.answers,
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.plan.respond": {
        const pending = doc.pendingPlan;
        return pending === null || pending.turnId !== command.turnId
          ? { events: () => {}, reason: "no pending plan" }
          : {
              events: () =>
                next(
                  "thread.plan.responded",
                  {
                    turnId: command.turnId,
                    action: command.action,
                    ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.queue.remove": {
        return doc.queue.some((message) => message.queuedMessageId === command.queuedMessageId)
          ? {
              events: () =>
                next("thread.message.dequeued", { queuedMessageId: command.queuedMessageId }),
            }
          : { events: () => {}, reason: "no such queued message" };
      }
      case "thread.queue.reorder": {
        const from = doc.queue.findIndex(
          (message) => message.queuedMessageId === command.queuedMessageId,
        );
        if (from === -1 || command.toIndex >= doc.queue.length) {
          return { events: () => {}, reason: "no such queue position" };
        }
        const order = doc.queue.map((message) => message.queuedMessageId);
        order.splice(from, 1);
        order.splice(command.toIndex, 0, command.queuedMessageId);
        return { events: () => next("thread.queue.reordered", { order }) };
      }
      case "thread.settings.update": {
        return {
          events: () => next("thread.settings.updated", settingsPatch(command)),
        };
      }
      default:
        return { events: () => {}, reason: `fixture does not handle ${command.type}` };
    }
  };

  /** What the fixture connector says it can do; `steering` follows the toggle. */
  const capabilities = (): ConnectorCapabilities => ({
    modelSwitch: "per-turn",
    effortSwitch: "per-turn",
    steering,
    planMode: true,
    subagents: true,
    images: true,
    resume: true,
    fork: false,
    interrupt: "turn",
    rollback: false,
    compaction: false,
    questions: true,
    runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    attachments: "files",
  });

  const connector = (): ConnectorSummary => ({
    connectorInstanceId,
    kind: "fixture",
    displayName: "Fixture connector",
    enabled: true,
    capabilities: capabilities(),
    extensions: { skills: true, plugins: true, mcpServers: false },
    probe: { status: "ready", probedAt: NOW },
  });

  /** Rebind the session with the connector's current capabilities. */
  const bindSession = (): void =>
    next("thread.session.bound", {
      connectorInstanceId,
      connectorKind: "fixture",
      sessionRef: { ref: "fixture" },
      capabilities: capabilities(),
    });

  /**
   * A second instance of the same kind, so the model picker has two sections.
   * The fixture thread is bound to the first, so this one shows disabled.
   */
  const secondConnector = (): ConnectorSummary => ({
    ...connector(),
    connectorInstanceId: secondInstanceId,
    displayName: "Second fixture connector",
    extensions: { skills: false, plugins: false, mcpServers: false },
  });

  /** What the fixture build "ships": the one connector kind above, with a form. */
  const descriptor: ConnectorDescriptor = {
    kind: "fixture",
    metadata: { displayName: "Fixture connector", iconKey: "terminal", accent: "#6b7280" },
    configFields: [
      {
        key: "binaryPath",
        label: "Binary path",
        description: "Path to the harness binary. Leave empty to use the discovered one.",
        control: "path",
        placeholder: "harness",
        optional: true,
      },
    ],
  };

  const client = new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "server.hello":
          return () => Effect.succeed({ protocolVersion: PROTOCOL_VERSION, serverInstanceId });
        case "threads.subscribe":
          return () =>
            Stream.suspend(() =>
              Stream.concat(
                Stream.succeed({ kind: "snapshot" as const, snapshot: doc }),
                Stream.fromQueue(queue),
              ),
            );
        case "threads.listSubscribe":
          return () => Stream.never;
        case "orchestration.dispatch":
          return ({ command }: { command: Command }) =>
            Effect.sync(() => {
              const outcome = decide(command);
              outcome.events();
              const receipt: CommandReceipt = {
                commandId: command.commandId,
                status: outcome.reason === undefined ? "accepted" : "rejected",
                ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
                lastSequence: doc.snapshotSequence,
              };
              handle.onCommand?.(command, receipt);
              return receipt;
            });
        case "files.search": {
          return ({ query }: { query: string }) =>
            Effect.succeed(
              FIXTURE_FILES.filter(
                (file) =>
                  query.trim().length === 0 ||
                  file.path.toLowerCase().includes(query.trim().toLowerCase()),
              ).slice(0, 20),
            );
        }
        // Attachments in the fixture never leave the browser: staging echoes a
        // plausible reference, and reading one back answers the placeholder
        // pixel, so the composer's upload path can be driven with no server.
        case "attachments.stage":
          return ({ threadId, name, base64 }: { threadId: string; name: string; base64: string }) =>
            Effect.sync(() => {
              const path = `/fixture/attachments/${threadId}/${name}`;
              fixtureAttachments.set(path, base64);
              return {
                path,
                name,
                mime: "image/png",
                size: Math.floor((base64.length * 3) / 4),
                sha256: "0".repeat(64),
              };
            });
        case "attachments.read":
          return ({ path }: { path: string }) =>
            Effect.sync(() => {
              const base64 = fixtureAttachments.get(path) ?? FIXTURE_PIXEL;
              return { mime: "image/png", size: Math.floor((base64.length * 3) / 4), base64 };
            });
        case "connectors.list":
          return () => Effect.sync(() => [connector(), secondConnector()]);
        case "connectors.models":
          return ({ instanceId }: { instanceId: string }) =>
            Effect.succeed(
              instanceId === connectorInstanceId ? FIXTURE_MODELS : FIXTURE_MODELS.slice(1),
            );
        case "connectors.describe":
          return () => Effect.succeed([descriptor]);
        case "connectors.skills.list":
          return () => Effect.succeed(FIXTURE_SKILLS.filter((skill) => skill.enabled));
        case "connectors.plugins.list":
          return ({ instanceId }: { instanceId: string }) =>
            instanceId === connectorInstanceId
              ? Effect.succeed(FIXTURE_PLUGINS)
              : Effect.fail(
                  new OpenAdeRpcError({
                    code: "unavailable",
                    message: `connector instance ${instanceId} does not manage plugins`,
                  }),
                );
        case "keybindings.get":
          return () => Effect.succeed(keybindings);
        case "keybindings.update":
          return ({ keybindings: next }: { keybindings: ReadonlyArray<Keybinding> }) =>
            Effect.sync(() => {
              keybindings = [...next];
              return keybindings;
            });
        case "settings.get":
          return () => Effect.succeed(defaultSettings());
        case "settings.subscribe":
          return () => Stream.succeed(defaultSettings());
        case "projects.list":
          return () =>
            Effect.succeed([
              {
                projectId,
                name: "fixture project",
                workspaceRoot: "/fixture",
                createdAt: NOW,
                updatedAt: NOW,
                threadCount: 1,
              },
            ]);
        default:
          return () => Effect.die(new Error(`fixture: unimplemented rpc ${String(key)}`));
      }
    },
  });

  const state = Effect.runSync(
    SubscriptionRef.make<ConnectionState>({ status: "connected", serverInstanceId }),
  );

  handle = {
    layer: Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state }),
      Layer.succeed(ConnectionStateRef, state),
    ),
    threadId,
    projectId,
    emit: (type, payload) => next(type, payload),
    emitItem: offer,
    startTurn,
    completeTurn,
    doc: () => doc,
    steering: () => steering,
    setSteering: (on) => {
      steering = on;
      bindSession();
    },
    reset: () => {
      doc = baseDoc(threadId, projectId, connectorInstanceId);
      streamVersion = 0;
      offer({ kind: "resnapshot-required", reason: "fixture reset" });
      offer({ kind: "snapshot", snapshot: doc });
      bindSession();
    },
    onCommand: undefined,
  };
  return handle;
};
