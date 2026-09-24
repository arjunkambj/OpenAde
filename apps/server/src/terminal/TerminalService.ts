/**
 * The real `TerminalService` behind the RPC tag in `../rpc/services`: the
 * registry of every owner's terminals, the output stream a client attaches
 * to, and the teardown that ends shells nobody can reach any more.
 *
 * An owner is a thread, or a project that has no thread yet — the New task
 * page's terminal, started in the project's folder (`TerminalOwner`). The
 * registry keys owners by `terminalOwnerKey`, so a thread's terminals and a
 * project's are never the same set, and a terminal id is only ever one
 * owner's.
 *
 * A terminal outlives its subscribers. Switching threads drops the client's
 * subscription and leaves the shell running; coming back resubscribes and
 * gets a snapshot of the scrollback first. An exited terminal stays listed,
 * with its final output, until the client closes it, so a reattaching client
 * still sees why a process died. Nothing is persisted: a server restart ends
 * every terminal.
 *
 * Shells end on `terminal.close`; a thread's on `thread.deleted` and
 * `thread.archived` (the same rule the browser pane's teardown follows), a
 * project's own on `project.removed` (which deletes its threads, and so ends
 * theirs too); and every one when the service's scope closes, which is the
 * server shutting down.
 */
import { stat } from "node:fs/promises";

import type { ProjectId, TerminalId, ThreadId } from "@OpenAde/contracts/ids";
import type { OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import {
  TERMINAL_STREAM_BUDGET_BYTES,
  TERMINAL_STREAM_BUDGET_ITEMS,
  TERMINALS_PER_THREAD,
  isThreadOwner,
  terminalOwnerKey,
  terminalOwnerOf,
  type TerminalOwner,
  type TerminalStreamItem,
  type TerminalSummary,
} from "@OpenAde/contracts/terminal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeLiveBuffer, sizeOfJson } from "../orchestration/LiveBuffer";
import { OrchestrationEngine } from "../orchestration/Engine";
import { threadWorkspaceRoot } from "../orchestration/workspaceRoot";
import { TerminalService } from "../rpc/services";
import { spawnPty } from "./pty";
import { makeSession, type TerminalSession } from "./session";
import { resolveShell, terminalEnv, type ShellCommand } from "./shell";

const DEFAULT_TITLE = "Terminal";

export interface TerminalServiceOptions {
  /**
   * The directory an owner's terminals start in: a thread's workspace root,
   * so a worktree thread's terminals start in its worktree, or a project's
   * folder.
   */
  readonly workspaceFor: (owner: TerminalOwner) => Effect.Effect<string, OpenAdeRpcError>;
  /** The engine's event subscription, for the teardown reactor. */
  readonly events: Effect.Effect<PubSub.Subscription<OrchestrationEvent>, never, Scope.Scope>;
  readonly spawn?: typeof spawnPty;
  /** Defaults to the user's login shell. */
  readonly shell?: ShellCommand;
  /** The base environment, before `terminalEnv` scrubs it. Defaults to the server's. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** What an owner is called in a refusal. */
const ownerNoun = (owner: TerminalOwner): string =>
  isThreadOwner(owner) ? "this thread" : "this project";

/** Whether `root` is a directory that still exists: a shell started in a deleted one would only print errors. */
const isDirectory = (root: string) =>
  Effect.promise(() =>
    stat(root).then(
      (stats) => stats.isDirectory(),
      () => false,
    ),
  );

/**
 * A thread's workspace root — its worktree when it has one, its project's
 * folder otherwise — as long as it still exists on disk.
 */
const threadWorkspace = (engine: OrchestrationEngine["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const doc = yield* engine.threadDoc(threadId);
    if (doc === null || doc.deleted) {
      return yield* notFound(`thread ${threadId} does not exist`);
    }
    if (doc.status === "archived") {
      return yield* new OpenAdeRpcError({
        code: "invalid",
        message: "the thread is archived; unarchive it to open a terminal",
      });
    }
    const project = yield* engine.projectDoc(doc.projectId);
    if (project === null) {
      return yield* notFound(`project ${doc.projectId} does not exist`);
    }
    const root = threadWorkspaceRoot(doc, project);
    if (!(yield* isDirectory(root))) {
      return yield* new OpenAdeRpcError({
        code: "invalid",
        message:
          root === project.workspaceRoot
            ? "the project folder no longer exists"
            : "the thread's worktree no longer exists",
      });
    }
    return root;
  });

/**
 * A project's folder, as long as the project is still there and so is the
 * folder. There is no thread, so no worktree: a project terminal is the
 * project's own checkout.
 */
const projectWorkspace = (engine: OrchestrationEngine["Service"], projectId: ProjectId) =>
  Effect.gen(function* () {
    const project = yield* engine.projectDoc(projectId);
    if (project === null || project.removed) {
      return yield* notFound(`project ${projectId} does not exist`);
    }
    if (!(yield* isDirectory(project.workspaceRoot))) {
      return yield* new OpenAdeRpcError({
        code: "invalid",
        message: "the project folder no longer exists",
      });
    }
    return project.workspaceRoot;
  });

/** Where an owner's terminals start: its thread's workspace, or its project's folder. */
export const workspaceOf =
  (engine: OrchestrationEngine["Service"]) =>
  (owner: TerminalOwner): Effect.Effect<string, OpenAdeRpcError> =>
    (isThreadOwner(owner)
      ? threadWorkspace(engine, owner.threadId)
      : projectWorkspace(engine, owner.projectId)
    ).pipe(
      // The SQL detail stays in the server log; the client learns the lookup failed.
      Effect.catchTag("SqlError", (error) =>
        Effect.logWarning("terminal workspace lookup failed", error).pipe(
          Effect.andThen(
            Effect.fail(
              new OpenAdeRpcError({
                code: "internal",
                message: `${isThreadOwner(owner) ? "thread" : "project"} lookup failed`,
              }),
            ),
          ),
        ),
      ),
    );

export const makeTerminalService = (
  injected: TerminalServiceOptions,
): Effect.Effect<TerminalService["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const platform = injected.platform ?? process.platform;
    const baseEnv = injected.env ?? process.env;
    const env = terminalEnv(baseEnv, platform);
    const shell = injected.shell ?? resolveShell(platform, baseEnv);
    const spawn = injected.spawn ?? spawnPty;
    const serviceScope = yield* Effect.scope;

    /**
     * By `terminalOwnerKey`. Insertion order is creation order, which is the
     * order `list` promises.
     */
    const registry = new Map<string, Map<TerminalId, TerminalSession>>();
    /** Opens and teardowns of one owner, one at a time: the limit is a count. */
    const locks = new Map<string, Semaphore.Semaphore>();
    let shuttingDown = false;

    const lockOf = (key: string) => {
      let lock = locks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      return lock;
    };

    const find = (owner: TerminalOwner, terminalId: TerminalId) => {
      const session = registry.get(terminalOwnerKey(owner))?.get(terminalId);
      return session === undefined
        ? Effect.fail(
            new OpenAdeRpcError({
              code: "not-found",
              message: `terminal ${terminalId} is not open on ${ownerNoun(owner)}`,
            }),
          )
        : Effect.succeed(session);
    };

    const open: TerminalService["Service"]["open"] = (input) => {
      const owner = terminalOwnerOf(input);
      const key = terminalOwnerKey(owner);
      return lockOf(key).withPermits(1)(
        Effect.gen(function* () {
          if (shuttingDown) {
            return yield* new OpenAdeRpcError({
              code: "unavailable",
              message: "the server is shutting down",
            });
          }
          const sessions = registry.get(key) ?? new Map<TerminalId, TerminalSession>();
          const existing = sessions.get(input.terminalId);
          if (existing !== undefined) {
            const current = existing.summary();
            if (current.cols !== input.cols || current.rows !== input.rows) {
              existing.resize(input.cols, input.rows);
            }
            return existing.summary();
          }
          for (const [otherKey, others] of registry) {
            if (otherKey !== key && others.has(input.terminalId)) {
              return yield* new OpenAdeRpcError({
                code: "conflict",
                message: `terminal ${input.terminalId} belongs to another thread or project`,
              });
            }
          }
          if (sessions.size >= TERMINALS_PER_THREAD) {
            return yield* new OpenAdeRpcError({
              code: "conflict",
              message: `${ownerNoun(owner)} already has ${TERMINALS_PER_THREAD} terminals; close one to open another`,
            });
          }
          const cwd = yield* injected.workspaceFor(owner);
          const title = input.title?.trim() ?? "";
          const session = yield* makeSession({
            owner,
            terminalId: input.terminalId,
            title: title === "" ? DEFAULT_TITLE : title,
            cwd,
            cols: input.cols,
            rows: input.rows,
            shell,
            env,
            spawn,
            platform,
          }).pipe(
            Effect.catchTags({
              PtyUnavailable: (error) =>
                Effect.fail(new OpenAdeRpcError({ code: "unavailable", message: error.message })),
              PtySpawnFailed: (error) =>
                Effect.fail(
                  new OpenAdeRpcError({
                    code: "internal",
                    message: `could not start ${error.file}: ${error.message}`,
                  }),
                ),
            }),
          );
          sessions.set(input.terminalId, session);
          registry.set(key, sessions);
          return session.summary();
        }),
      );
    };

    /** Forgets the terminal first, so nothing can reach a shell that is on its way out. */
    const remove = (owner: TerminalOwner, terminalId: TerminalId) => {
      const key = terminalOwnerKey(owner);
      const sessions = registry.get(key);
      sessions?.delete(terminalId);
      if (sessions !== undefined && sessions.size === 0) registry.delete(key);
    };

    const teardown = (owner: TerminalOwner): Effect.Effect<void> => {
      const key = terminalOwnerKey(owner);
      return lockOf(key).withPermits(1)(
        Effect.gen(function* () {
          const sessions = [...(registry.get(key)?.values() ?? [])];
          registry.delete(key);
          yield* Effect.forEach(sessions, (session) => session.kill, {
            concurrency: "unbounded",
            discard: true,
          });
        }),
      );
    };

    const subscribe = (
      owner: TerminalOwner,
      terminalId: TerminalId,
    ): Stream.Stream<TerminalStreamItem, OpenAdeRpcError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* find(owner, terminalId);
          // Subscribe before reading the scrollback: output published in
          // between is then in both, and the offset filter below drops the
          // copy. Read the other way round, it would be in neither.
          const live = yield* PubSub.subscribe(session.hub);
          const view = session.view();
          const baseline: Array<TerminalStreamItem> = [
            { kind: "snapshot", terminal: view.summary, data: view.data, offset: view.offset },
          ];
          if (view.exit !== null) {
            // The snapshot already holds every byte the shell wrote, and
            // nothing follows an exit.
            const exitCode = view.exit.signal === null ? view.exit.exitCode : null;
            baseline.push({ kind: "exited", exitCode, signal: view.exit.signal });
            return Stream.fromIterable(baseline);
          }
          // A budget rather than a backlog: a client that stops reading is
          // told to resubscribe for a fresh snapshot. Terminal output is never
          // merged — every item is a boundary.
          const buffer = yield* makeLiveBuffer<TerminalStreamItem>({
            window: 0,
            maxItems: TERMINAL_STREAM_BUDGET_ITEMS,
            maxBytes: TERMINAL_STREAM_BUDGET_BYTES,
            sizeOf: sizeOfJson,
            mergeKeyOf: () => null,
            overflowItem: (reason) => ({ kind: "resnapshot-required", reason }),
          });
          yield* Stream.fromSubscription(live).pipe(
            Stream.filter((item) => item.kind !== "output" || item.offset > view.offset),
            Stream.takeUntil((item) => item.kind === "exited"),
            Stream.runForEach((item) => buffer.offer(item)),
            Effect.andThen(buffer.close()),
            Effect.forkScoped,
          );
          return Stream.concat(Stream.fromIterable(baseline), buffer.stream);
        }),
      );

    // A closed thread ends its shells — deleted or archived — and a removed
    // project ends its own. Subscribed here, not in the forked fiber, so no
    // event published before the fiber's first tick is missed; its own scope
    // releases the subscription when it ends.
    const reactorScope = yield* Scope.make();
    const events = yield* Scope.provide(reactorScope)(injected.events);
    const reactor = Stream.runForEach(Stream.fromSubscription(events), (event) =>
      event.type === "thread.deleted" || event.type === "thread.archived"
        ? teardown({ threadId: event.streamId as ThreadId })
        : event.type === "project.removed"
          ? teardown({ projectId: event.payload.projectId })
          : Effect.void,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("terminal teardown reactor ended", error)),
      Effect.ensuring(Scope.close(reactorScope, Exit.void)),
    );
    yield* Effect.forkIn(reactor, serviceScope);

    // Shutdown: no shell outlives the server. Each kill is bounded, so a
    // wedged pty cannot hold the shutdown up.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        shuttingDown = true;
        const sessions = [...registry.values()].flatMap((byId) => [...byId.values()]);
        registry.clear();
        yield* Effect.forEach(sessions, (session) => session.kill, {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    );

    return TerminalService.of({
      open,
      write: (owner, terminalId, data) =>
        Effect.map(find(owner, terminalId), (session) => session.write(data)),
      resize: (owner, terminalId, cols, rows) =>
        Effect.map(find(owner, terminalId), (session) => session.resize(cols, rows)),
      // Uninterruptible from the lookup on: once the terminal is out of the
      // registry, this call is the only thing that can still end its shell,
      // so a client that interrupts the call (or drops its connection) must
      // not stop the kill part way.
      close: (owner, terminalId) =>
        Effect.uninterruptible(
          Effect.flatMap(find(owner, terminalId), (session) => {
            remove(owner, terminalId);
            return session.kill;
          }),
        ),
      list: (owner) =>
        Effect.sync((): ReadonlyArray<TerminalSummary> =>
          [...(registry.get(terminalOwnerKey(owner))?.values() ?? [])].map((session) =>
            session.summary(),
          ),
        ),
      subscribe,
      teardownThread: (threadId) => teardown({ threadId }),
    });
  });

export const layer: Layer.Layer<TerminalService, never, OrchestrationEngine> = Layer.effect(
  TerminalService,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    return yield* makeTerminalService({
      workspaceFor: workspaceOf(engine),
      events: engine.subscribeEvents,
    });
  }),
);

const notFound = (message: string) =>
  Effect.fail(new OpenAdeRpcError({ code: "not-found", message }));
