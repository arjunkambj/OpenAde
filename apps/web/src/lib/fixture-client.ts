/**
 * The `/dev/composer` fixture: a `Connection` layer over an in-process fake
 * whose `orchestration.dispatch` runs a tiny decider — `approval.respond`
 * emits `approval.resolved`, `turn.start` emits `message.queued` or
 * `turn.requested`+`turn.started`, and so on — so the cards and the queue
 * strip exercise the real round trip: the UI changes only when the event
 * lands on the subscription, never optimistically.
 *
 * `fixture.emit(type, payload)` folds the event into the fixture's doc and
 * pushes it onto the stream, which is how the page's scenario buttons drive
 * states the server would normally produce (a mid-turn approval, a plan, a
 * question). `fixture.onCommand` is the page's dispatch log.
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
import { PROTOCOL_VERSION } from "@OpenAde/contracts/rpc";
import type {
  ConnectorDescriptor,
  ConnectorSummary,
  FileSearchResult,
  ModelOption,
  SkillSummary,
} from "@OpenAde/contracts/rpc";
import { defaultSettings, DEFAULT_KEYBINDINGS } from "@OpenAde/contracts/settings";
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
    name: "bench",
    path: "skills/bench.md",
    description: "Run the benchmark suite",
    enabled: false,
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
  const serverInstanceId = uuidV7();

  const queue = Effect.runSync(Queue.unbounded<ThreadStreamItem>());
  let doc = baseDoc(threadId, projectId, connectorInstanceId);
  let streamVersion = 0;
  let keybindings: ReadonlyArray<Keybinding> = [...DEFAULT_KEYBINDINGS];
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
      actor: "connector" as const,
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
            });
            next("thread.turn.started", { turnId });
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
                next("thread.approval.resolved", {
                  requestId: command.requestId,
                  decision: command.decision,
                  ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
                }),
            };
      }
      case "thread.userInput.respond": {
        const pending = doc.pendingUserInput;
        return pending === null || pending.requestId !== command.requestId
          ? { events: () => {}, reason: "no matching question request" }
          : {
              events: () =>
                next("thread.userInput.resolved", {
                  requestId: command.requestId,
                  answers: command.answers,
                }),
            };
      }
      case "thread.plan.respond": {
        const pending = doc.pendingPlan;
        return pending === null || pending.turnId !== command.turnId
          ? { events: () => {}, reason: "no pending plan" }
          : {
              events: () =>
                next("thread.plan.responded", {
                  turnId: command.turnId,
                  action: command.action,
                  ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
                }),
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

  const connector: ConnectorSummary = {
    connectorInstanceId,
    kind: "fixture",
    displayName: "Fixture connector",
    enabled: true,
    capabilities: {
      modelSwitch: "per-turn",
      effortSwitch: "per-turn",
      steering: false,
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
    },
    probe: { status: "ready", probedAt: NOW },
  };

  /** What the fixture build "ships": the one connector kind above, with a form. */
  const descriptor: ConnectorDescriptor = {
    kind: connector.kind,
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
          return () => Effect.succeed([connector]);
        case "connectors.models":
          return () => Effect.succeed(FIXTURE_MODELS);
        case "connectors.describe":
          return () => Effect.succeed([descriptor]);
        case "cmdConfig.skills.list":
          return () => Effect.succeed(FIXTURE_SKILLS.filter((skill) => skill.enabled));
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
    reset: () => {
      doc = baseDoc(threadId, projectId, connectorInstanceId);
      streamVersion = 0;
      offer({ kind: "resnapshot-required", reason: "fixture reset" });
      offer({ kind: "snapshot", snapshot: doc });
    },
    onCommand: undefined,
  };
  return handle;
};
