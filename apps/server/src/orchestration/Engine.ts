/**
 * The orchestration engine: the single writer of durable state.
 *
 * `dispatch(command)` — load the aggregate's stream, run the pure decider,
 * append the events, write the projections and the receipt, all inside one
 * SQLite transaction, then publish to subscribers. `commandId` idempotency
 * makes retries and reconnects safe: a receipted command returns its stored
 * receipt instead of re-deciding.
 *
 * `appendThreadEvents` is the same append path minus the decider, for
 * connector- and system-originated events (ingestion, supervisor, reactors).
 *
 * Subscriptions are `snapshot | replay → synchronized → live`: a coalesced,
 * budgeted stream that ends in `resnapshot-required` when a client falls too
 * far behind.
 */

import { makeEventId, makeItemId, makeTurnId } from "@OpenAde/contracts/ids";
import type { EventId, ItemId, ProjectId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type {
  Command,
  CommandReceipt,
  OrchestrationEvent,
  ProjectSummary,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Duration from "effect/Duration";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { EventStore, type ConcurrencyConflict, type PlannedEvent } from "../persistence/EventStore";
import { layer as migrationsLayer } from "../persistence/Migrations";
import { PERMISSION_RULES_KEY } from "../permissions/PermissionService";
import { readConnectorRouting } from "../settings/connectorRouting";
import { ReadModelStore } from "../persistence/ReadModels";
import {
  foldProject,
  foldThread,
  projectProjectEvent,
  projectThreadEvent,
  threadSnapshotOf,
  threadSummaryOf,
  type ProjectDoc,
  type ThreadDoc,
} from "./state";
import {
  decide,
  streamOf,
  type DeciderContext,
  type DecideEnv,
  type NewPermissionRule,
} from "./decider";
import { makeLiveBuffer, sizeOfJson, threadItemMergeKey, threadListMergeKey } from "./LiveBuffer";

export type EngineError = SqlError | ConcurrencyConflict;

/**
 * Where the engine mints identifiers and timestamps. A `Context.Reference`
 * so tests can pin ids and clock via `Effect.provideService(EngineEnv, ...)`
 * for byte-identical streams; production uses the defaults.
 */
export const EngineEnv = Context.Reference<{
  readonly now: () => string;
  readonly nextEventId: () => EventId;
  readonly nextTurnId: () => TurnId;
  readonly nextItemId: () => ItemId;
}>("server/orchestration/EngineEnv", {
  defaultValue: () => ({
    now: () => new Date().toISOString(),
    nextEventId: makeEventId,
    nextTurnId: makeTurnId,
    nextItemId: makeItemId,
  }),
});

/** An accepted command as reactors observe it. */
export interface AcceptedCommand {
  readonly command: Command;
  readonly receipt: CommandReceipt;
}

export interface SubscribeOptions {
  readonly afterSequence?: number;
  /** Coalescing window override — tests pass `0` for synchronous delivery. */
  readonly coalesceWindow?: Duration.Input;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

const PROJECTOR = "orchestration";

/**
 * Bump whenever the shape of a stored `ThreadDoc`/`ProjectDoc` changes. The
 * engine compares it against what wrote the rows and, on a mismatch, throws
 * the projections away and re-folds every stream from the event log — the log
 * is the source of truth, so a stale document is never served.
 */
const PROJECTOR_VERSION = 1;

export class OrchestrationEngine extends Context.Service<
  OrchestrationEngine,
  {
    readonly dispatch: (command: Command) => Effect.Effect<CommandReceipt, EngineError>;
    /**
     * Appends connector/system events to a thread stream, projecting and
     * publishing exactly like `dispatch`. Resolves to the log position.
     *
     * `planned` may be a function of the thread doc instead of a fixed list.
     * The function runs inside the write transaction, on the doc as it is at
     * append time, so a caller whose events depend on current state — "send
     * the head of the queue" — cannot be overtaken by a command decided
     * between its own read and this append. Returning an empty list appends
     * nothing.
     */
    readonly appendThreadEvents: (
      threadId: ThreadId,
      planned: ReadonlyArray<PlannedEvent> | ((doc: ThreadDoc) => ReadonlyArray<PlannedEvent>),
    ) => Effect.Effect<number, EngineError>;
    readonly subscribeThread: (
      threadId: ThreadId,
      options?: SubscribeOptions,
    ) => Effect.Effect<Stream.Stream<ThreadStreamItem>, SqlError | OpenAdeRpcError, Scope.Scope>;
    readonly subscribeThreadList: (
      options?: SubscribeOptions & { readonly projectId?: ProjectId },
    ) => Effect.Effect<Stream.Stream<ThreadListStreamItem>, SqlError, Scope.Scope>;
    readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectSummary>, SqlError>;
    readonly listThreads: (
      projectId?: ProjectId,
      includeArchived?: boolean,
    ) => Effect.Effect<ReadonlyArray<ThreadSummary>, SqlError>;
    readonly threadDetail: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadDetailSnapshot | null, SqlError>;
    readonly threadDoc: (threadId: ThreadId) => Effect.Effect<ThreadDoc | null, SqlError>;
    readonly threadDocs: Effect.Effect<ReadonlyArray<ThreadDoc>, SqlError>;
    readonly projectDoc: (projectId: ProjectId) => Effect.Effect<ProjectDoc | null, SqlError>;
    /**
     * Eager subscriptions for reactors — subscribing at layer build means the
     * reactor cannot miss events published between build and fiber start.
     */
    readonly subscribeEvents: Effect.Effect<
      PubSub.Subscription<OrchestrationEvent>,
      never,
      Scope.Scope
    >;
    readonly subscribeCommands: Effect.Effect<
      PubSub.Subscription<AcceptedCommand>,
      never,
      Scope.Scope
    >;
    /** Every committed event, in order — reactors and tests subscribe here. */
    readonly events: Stream.Stream<OrchestrationEvent>;
    /** Every accepted command, after commit — reactors that need intent watch this. */
    readonly commands: Stream.Stream<AcceptedCommand>;
  }
>()("server/orchestration/OrchestrationEngine") {
  static readonly layer = Layer.effect(
    OrchestrationEngine,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reactivity = yield* Reactivity.Reactivity;
      const store = yield* EventStore;
      const readModels = yield* ReadModelStore;

      // Rows written by an older projector cannot be trusted: a field added
      // to `ThreadDoc` since would read back as `undefined`. Rebuilding is a
      // pure re-fold of the log, so it is always safe to do at boot.
      const storedVersion = yield* readModels.projectorVersion(PROJECTOR);
      if (storedVersion !== PROJECTOR_VERSION) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* readModels.clearProjections;
            const events = yield* store.allEvents;
            const streams = new Map<string, Array<OrchestrationEvent>>();
            for (const entry of events) {
              const key = `${entry.streamKind}:${entry.streamId}`;
              const bucket = streams.get(key);
              if (bucket === undefined) {
                streams.set(key, [entry]);
              } else {
                bucket.push(entry);
              }
            }
            for (const [key, stream] of streams) {
              if (key.startsWith("project:")) {
                const doc = foldProject(stream);
                if (doc !== null && !doc.removed) {
                  yield* readModels.putProject(doc);
                }
                continue;
              }
              const doc = foldThread(stream);
              if (doc !== null && !doc.deleted) {
                yield* readModels.putThread(doc);
              }
            }
            const last = events.length === 0 ? 0 : events[events.length - 1]!.sequence;
            yield* readModels.setWatermark(
              PROJECTOR,
              last,
              new Date().toISOString(),
              PROJECTOR_VERSION,
            );
          }),
        );
      }

      // One writer: every mutation — command or reactor write — serialises here,
      // and the transaction below makes the mutation itself atomic.
      const writeMutex = yield* Semaphore.make(1);
      const eventsPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
      const commandsPubSub = yield* PubSub.unbounded<AcceptedCommand>();

      const mintEnv = Effect.map(EngineEnv, (env): DecideEnv => ({
        now: env.now(),
        nextEventId: env.nextEventId,
        nextTurnId: env.nextTurnId,
        nextItemId: env.nextItemId,
      }));

      /**
       * The model a `thread.create` without one starts on.
       *
       * The app-wide default first, and then the connector's own, so that a
       * `defaultModel` on the connectors page means "new threads on this
       * connector" rather than nothing at all. Which connector that is comes
       * from `readConnectorRouting` — the same reading `ConnectorSelection`
       * routes by, so the seeded model belongs to the instance the thread's
       * first turn will actually run on.
       */
      const defaultModel = Effect.map(
        readConnectorRouting(sql),
        (routing) => routing.sharedModel ?? routing.enabled[0]?.defaultModel ?? null,
      );

      /** Cross-aggregate facts the decider may check, gathered inside the txn. */
      const buildContext = (command: Command): Effect.Effect<DeciderContext, SqlError> =>
        Effect.gen(function* () {
          const projectId = command.type === "thread.create" ? command.projectId : null;
          const exists = projectId === null ? false : yield* readModels.projectExists(projectId);
          const roots = command.type === "project.create" ? yield* readModels.workspaceRoots : [];
          const model = command.type === "thread.create" ? yield* defaultModel : null;
          // A checkpoint restore rewrites the project's whole workspace root,
          // so the commands it excludes have to see every sibling thread's
          // `restoring` flag, not just their own stream's.
          const guardsRestore =
            command.type === "thread.turn.start" || command.type === "thread.checkpoint.restore";
          const restoring = guardsRestore
            ? (yield* readModels.listThreadDocs).filter((doc) => !doc.deleted && doc.restoring)
            : [];
          return {
            projectExists: (id) => id === projectId && exists,
            workspaceRootTaken: (root) => roots.includes(root),
            restoreInFlight: (id, exceptThreadId) =>
              restoring.some((doc) => doc.projectId === id && doc.threadId !== exceptThreadId),
            defaultModel: model,
          };
        });

      const insertPermissionRule = (rule: NewPermissionRule, at: string) =>
        sql`
          INSERT INTO permission_rules
            (scope, project_id, thread_id, pattern, decision, created_at)
          VALUES (
            ${rule.scope}, ${rule.projectId ?? ""}, ${rule.threadId ?? ""},
            ${rule.pattern}, ${rule.decision}, ${at}
          )
          ON CONFLICT (scope, project_id, thread_id, pattern) DO UPDATE SET
            decision = excluded.decision,
            created_at = excluded.created_at
        `.pipe(Effect.asVoid);

      /** Writes the projections a set of appended events imply. */
      const applyProjection = (
        streamKind: "project" | "thread",
        state: { project: ProjectDoc | null; thread: ThreadDoc | null },
        appended: ReadonlyArray<OrchestrationEvent>,
      ): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          if (streamKind === "thread") {
            const doc = appended.reduce(
              (acc, event) => projectThreadEvent(acc, event),
              state.thread,
            );
            if (doc === null) {
              return;
            }
            yield* doc.deleted ? readModels.removeThread(doc.threadId) : readModels.putThread(doc);
            return;
          }
          const project = appended.reduce(
            (acc, event) => projectProjectEvent(acc, event),
            state.project,
          );
          if (project === null) {
            return;
          }
          yield* project.removed
            ? readModels.removeProject(project.projectId)
            : readModels.putProject(project);
        });

      const commit = Effect.fn("OrchestrationEngine.commit")(function* (
        streamKind: "project" | "thread",
        streamId: string,
        state: { project: ProjectDoc | null; thread: ThreadDoc | null },
        planned: ReadonlyArray<PlannedEvent>,
      ) {
        const appended = yield* store.append(streamKind, streamId, planned);
        yield* applyProjection(streamKind, state, appended);
        const last =
          appended.length > 0 ? appended[appended.length - 1]!.sequence : yield* store.lastSequence;
        yield* readModels.setWatermark(
          PROJECTOR,
          last,
          new Date().toISOString(),
          PROJECTOR_VERSION,
        );
        return { appended, last };
      });

      const dispatch = (command: Command): Effect.Effect<CommandReceipt, EngineError> =>
        writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* store.receipt(command.commandId);
            if (existing !== null) {
              return existing;
            }
            const env = yield* mintEnv;
            const { receipt, appended, wroteRule } = yield* sql.withTransaction(
              Effect.gen(function* () {
                const { streamKind, streamId } = streamOf(command);
                const streamEvents = yield* store.loadStream(streamKind, streamId);
                const state =
                  streamKind === "project"
                    ? { project: foldProject(streamEvents), thread: null }
                    : { project: null, thread: foldThread(streamEvents) };
                const ctx = yield* buildContext(command);
                const result = decide(command, state, ctx, env);
                if (!result.accepted) {
                  const lastSequence = yield* store.lastSequence;
                  const rejectedReceipt: CommandReceipt = {
                    commandId: command.commandId,
                    status: "rejected",
                    reason: result.reason,
                    lastSequence,
                  };
                  yield* store.recordReceipt(rejectedReceipt, env.now);
                  return { receipt: rejectedReceipt, appended: [], wroteRule: false };
                }
                const { appended, last } = yield* commit(
                  streamKind,
                  streamId,
                  state,
                  result.events,
                );
                if (result.permissionRule !== undefined) {
                  yield* insertPermissionRule(result.permissionRule, env.now);
                }
                const acceptedReceipt: CommandReceipt = {
                  commandId: command.commandId,
                  status: "accepted",
                  lastSequence: last,
                };
                yield* store.recordReceipt(acceptedReceipt, env.now);
                return {
                  receipt: acceptedReceipt,
                  appended,
                  wroteRule: result.permissionRule !== undefined,
                };
              }),
            );
            yield* PubSub.publishAll(eventsPubSub, appended);
            // "Allow always" writes a rule behind the settings document's back,
            // and this is what lets an open settings page re-read it. It fires
            // after the transaction, like every other announcement here: a
            // subscriber told to re-read mid-transaction can see a row that the
            // rest of the dispatch then rolls back, and nothing would correct it.
            if (wroteRule) {
              yield* reactivity.invalidate([PERMISSION_RULES_KEY]);
            }
            if (receipt.status === "accepted") {
              yield* PubSub.publish(commandsPubSub, { command, receipt });
            }
            return receipt;
          }),
        );

      const appendThreadEvents = (
        threadId: ThreadId,
        planned: ReadonlyArray<PlannedEvent> | ((doc: ThreadDoc) => ReadonlyArray<PlannedEvent>),
      ): Effect.Effect<number, EngineError> =>
        writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const { appended, last } = yield* sql.withTransaction(
              Effect.gen(function* () {
                const doc = yield* readModels.getThreadDoc(threadId);
                if (doc === null || doc.deleted) {
                  return { appended: [] as ReadonlyArray<OrchestrationEvent>, last: 0 };
                }
                const events = typeof planned === "function" ? planned(doc) : planned;
                return yield* commit("thread", threadId, { project: null, thread: doc }, events);
              }),
            );
            if (appended.length > 0) {
              yield* PubSub.publishAll(eventsPubSub, appended);
            }
            return last;
          }),
        );

      const subscribeThread = (threadId: ThreadId, options: SubscribeOptions = {}) =>
        Effect.gen(function* () {
          // Subscribe before reading the baseline so nothing commits in the gap.
          const mailbox = yield* PubSub.subscribe(eventsPubSub);
          const buffer = yield* makeLiveBuffer<ThreadStreamItem>({
            window: options.coalesceWindow,
            maxItems: options.maxItems,
            maxBytes: options.maxBytes,
            sizeOf: sizeOfJson,
            mergeKeyOf: threadItemMergeKey,
            overflowItem: (reason) => ({ kind: "resnapshot-required", reason }),
          });

          let cutoff: number;
          const baseline: Array<ThreadStreamItem> = [];
          if (options.afterSequence === undefined) {
            const doc = yield* readModels.getThreadDoc(threadId);
            if (doc === null || doc.deleted) {
              return yield* new OpenAdeRpcError({
                code: "not-found",
                message: `thread ${threadId} does not exist`,
              });
            }
            baseline.push({ kind: "snapshot", snapshot: threadSnapshotOf(doc) });
            cutoff = doc.snapshotSequence;
          } else {
            const replayed = yield* store.streamAfter("thread", threadId, options.afterSequence);
            for (const event of replayed) {
              baseline.push({ kind: "event", event });
            }
            cutoff =
              replayed.length > 0 ? replayed[replayed.length - 1]!.sequence : options.afterSequence;
          }
          baseline.push({ kind: "synchronized" });

          const pump = Stream.fromSubscription(mailbox).pipe(
            Stream.filter(
              (event: OrchestrationEvent) =>
                event.streamKind === "thread" &&
                event.streamId === threadId &&
                event.sequence > cutoff,
            ),
            Stream.map((event): ThreadStreamItem => ({ kind: "event", event })),
            Stream.runForEach((item) => buffer.offer(item)),
            Effect.forkScoped,
          );
          yield* pump;

          return Stream.concat(Stream.fromIterable(baseline), buffer.stream);
        });

      /** One committed thread event → the list frames it produces. */
      const projectThreadEventToListItem = Effect.fn("projectThreadEventToListItem")(function* (
        event: OrchestrationEvent,
        projectId: ProjectId | undefined,
      ): Effect.fn.Return<ReadonlyArray<ThreadListStreamItem>, SqlError> {
        const threadId = event.streamId as ThreadId;
        if (event.type === "thread.deleted") {
          return [{ kind: "removed", threadId }];
        }
        const doc = yield* readModels.getThreadDoc(threadId);
        if (doc === null || doc.deleted) {
          return [];
        }
        if (projectId !== undefined && doc.projectId !== projectId) {
          return [];
        }
        return [{ kind: "upserted", thread: threadSummaryOf(doc) }];
      });

      const subscribeThreadList = (options: SubscribeOptions & { projectId?: ProjectId } = {}) =>
        Effect.gen(function* () {
          const mailbox = yield* PubSub.subscribe(eventsPubSub);
          const buffer = yield* makeLiveBuffer<ThreadListStreamItem>({
            window: options.coalesceWindow,
            maxItems: options.maxItems,
            maxBytes: options.maxBytes,
            sizeOf: sizeOfJson,
            mergeKeyOf: threadListMergeKey,
            overflowItem: (reason) => ({ kind: "resnapshot-required", reason }),
          });

          let cutoff: number;
          const baseline: Array<ThreadListStreamItem> = [];
          if (options.afterSequence === undefined) {
            const docs = (yield* readModels.listThreadDocs).filter(
              (doc) =>
                !doc.deleted &&
                (options.projectId === undefined || doc.projectId === options.projectId),
            );
            const last = yield* store.lastSequence;
            baseline.push({
              kind: "snapshot",
              snapshotSequence: last,
              threads: docs.map(threadSummaryOf),
            });
            cutoff = last;
          } else {
            const replayed = yield* store.threadEventsAfter(options.afterSequence);
            for (const event of replayed) {
              const projected = yield* projectThreadEventToListItem(event, options.projectId);
              baseline.push(...projected);
            }
            cutoff =
              replayed.length > 0 ? replayed[replayed.length - 1]!.sequence : options.afterSequence;
          }
          baseline.push({ kind: "synchronized" });

          yield* Stream.fromSubscription(mailbox).pipe(
            Stream.filter((event) => event.streamKind === "thread" && event.sequence > cutoff),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                const projected = yield* projectThreadEventToListItem(event, options.projectId);
                yield* buffer.offerAll(projected);
              }),
            ),
            Effect.forkScoped,
          );

          return Stream.concat(Stream.fromIterable(baseline), buffer.stream);
        });

      return OrchestrationEngine.of({
        dispatch,
        appendThreadEvents,
        subscribeThread,
        subscribeThreadList,
        listProjects: () => readModels.listProjects(),
        listThreads: (projectId, includeArchived) =>
          readModels.listThreads(projectId, includeArchived),
        threadDetail: (threadId) =>
          Effect.map(readModels.getThreadDoc(threadId), (doc) =>
            doc === null || doc.deleted ? null : threadSnapshotOf(doc),
          ),
        threadDoc: (threadId) => readModels.getThreadDoc(threadId),
        threadDocs: readModels.listThreadDocs,
        projectDoc: (projectId) => readModels.getProjectDoc(projectId),
        events: Stream.fromPubSub(eventsPubSub),
        commands: Stream.fromPubSub(commandsPubSub),
        subscribeEvents: PubSub.subscribe(eventsPubSub),
        subscribeCommands: PubSub.subscribe(commandsPubSub),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}
