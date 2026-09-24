/**
 * The terminal service over a real engine and a real `/bin/sh`, with `HOME` in
 * a temp dir so no rc file of the machine's user can change what the shell
 * prints:
 *
 * - A command's computed output reaches a subscriber, and the shell runs in
 *   the project's folder.
 * - A second subscriber reattaches: its snapshot holds the scrollback and
 *   lines up with the first subscriber's output, nothing lost or doubled.
 * - Resize reaches the shell; open is idempotent by id; the per-thread limit
 *   holds.
 * - An exited shell stays listed with its output until it is closed.
 * - Close, thread.deleted, thread.archived and the service's scope closing
 *   each end the shell; a close interrupted part way still ends it. An
 *   archived thread refuses a new terminal.
 *
 * Every wait is on output the shell computed or on an exit, never on time: the
 * terminal echoes what is typed, so matching the typed text would pass without
 * the shell running anything.
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { makeStreamCollector, type StreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import {
  makeCommandId,
  makeProjectId,
  makeTerminalId,
  makeThreadId,
  type ThreadId,
} from "@OpenAde/contracts/ids";
import type { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import { TERMINALS_PER_THREAD, type TerminalStreamItem } from "@OpenAde/contracts/terminal";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import type { TerminalService } from "../rpc/services";
import { type PtyExit, type PtyProcess, spawnPty } from "./pty";
import { makeTerminalService, workspaceOf } from "./TerminalService";

const NOW = "2026-01-02T03:04:05.000Z";
const SIZE = { cols: 80, rows: 24 };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line of output that is exactly `text`, not the echo of a command containing it. */
const line = (text: string) => new RegExp(`(^|\\n)${escapeRegExp(text)}\\r?\\n`);

const tempDir = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(nodePath.join(tmpdir(), `openade-terminal-${label}-`))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  );

interface Seen {
  readonly item: TerminalStreamItem;
  /** Everything the subscriber has been shown so far: the snapshot, then each output. */
  readonly text: string;
}

/** A subscriber that keeps a running transcript, so a wait can match across items. */
const watch = <E>(
  stream: Stream.Stream<TerminalStreamItem, E>,
): Effect.Effect<StreamCollector<Seen>, never, Scope.Scope> =>
  makeStreamCollector(
    stream.pipe(
      Stream.mapAccum(
        () => "",
        (text, item): readonly [string, ReadonlyArray<Seen>] => {
          const next = item.kind === "snapshot" || item.kind === "output" ? text + item.data : text;
          return [next, [{ item, text: next }]];
        },
      ),
    ),
  );

const awaitText = (collector: StreamCollector<Seen>, pattern: RegExp) =>
  collector.awaitItem((seen) => pattern.test(seen.text)).pipe(Effect.orDie);

const awaitKind = (collector: StreamCollector<Seen>, kind: TerminalStreamItem["kind"]) =>
  collector.awaitItem((seen) => seen.item.kind === kind).pipe(Effect.orDie);

interface Stack {
  readonly engine: OrchestrationEngine["Service"];
  readonly workspace: string;
  readonly home: string;
  /** Builds the service in `scope`, spawning through `spawn`. */
  readonly service: (
    scope: Scope.Scope,
    spawn?: typeof spawnPty,
  ) => Effect.Effect<TerminalService["Service"]>;
  /** A thread on a project rooted at `workspace`. */
  readonly thread: Effect.Effect<ThreadId>;
}

const buildStack: Effect.Effect<Stack, never, Scope.Scope> = Effect.gen(function* () {
  const sqliteContext = yield* Layer.build(sqliteTestLayer()).pipe(Effect.orDie);
  const sqlite = Layer.succeedContext(sqliteContext);
  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const context = yield* Layer.build(OrchestrationEngine.layer.pipe(Layer.provide(persistence)));
  const engine = Context.get(context, OrchestrationEngine);
  const workspace = yield* tempDir("workspace");
  const home = yield* tempDir("home");
  const projectId = makeProjectId();
  yield* engine.dispatch({
    commandId: makeCommandId(),
    createdAt: NOW,
    type: "project.create",
    projectId,
    name: "demo",
    workspaceRoot: workspace,
  });
  return {
    engine,
    workspace,
    home,
    service: (scope: Scope.Scope, spawn: typeof spawnPty = spawnPty) =>
      makeTerminalService({
        workspaceFor: workspaceOf(engine),
        events: engine.subscribeEvents,
        spawn,
        shell: { file: "/bin/sh", args: [] },
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " },
      }).pipe(Scope.provide(scope)),
    thread: Effect.gen(function* () {
      const threadId = makeThreadId();
      yield* engine.dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.create",
        threadId,
        projectId,
        settings: { model: "fake/model" },
      });
      return threadId;
    }).pipe(Effect.orDie),
  };
}).pipe(Effect.orDie);

/** The stack plus a service bound to the calling scope and one thread with a terminal. */
const withTerminal = Effect.gen(function* () {
  const stack = yield* buildStack;
  const terminals = yield* stack.service(yield* Effect.scope);
  const threadId = yield* stack.thread;
  const terminalId = makeTerminalId();
  const opened = yield* terminals.open({ threadId, terminalId, ...SIZE });
  return { ...stack, terminals, threadId, terminalId, opened };
});

const failureCode = <A>(effect: Effect.Effect<A, OpenAdeRpcError>) =>
  Effect.map(Effect.flip(effect), (error) => error.code);

describe.skipIf(process.platform === "win32")("TerminalService", () => {
  it.live("runs a command and streams what it computed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, opened } = yield* withTerminal;
        expect(opened).toMatchObject({ title: "Terminal", status: "running", exitCode: null });
        expect(opened.pid).toBeGreaterThan(0);

        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* terminals.write(threadId, terminalId, "echo $((20+22))\n");
        yield* awaitText(output, line("42"));
        const first = (yield* output.collected)[0]!.item;
        expect(first.kind).toBe("snapshot");
      }),
    ),
  );

  it.live("starts the shell in the project's folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, workspace } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        // `-P`: the directory the process is really in, not the `$PWD` it was handed.
        yield* terminals.write(threadId, terminalId, "pwd -P\n");
        yield* awaitText(output, line(realpathSync(workspace)));
      }),
    ),
  );

  it.live("reattaches with the scrollback, lined up with the live output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const first = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* terminals.write(threadId, terminalId, "echo $((20+22))\n");
        yield* awaitText(first, line("42"));
        const seenByFirst = (yield* first.collected).map(({ item }) =>
          item.kind === "snapshot" || item.kind === "output" ? item.offset : 0,
        );

        const second = yield* watch(terminals.subscribe(threadId, terminalId));
        const snapshot = (yield* awaitKind(second, "snapshot")).item;
        if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
        expect(snapshot.data).toMatch(line("42"));
        expect(snapshot.offset).toBeGreaterThanOrEqual(Math.max(...seenByFirst));

        // Both transcripts agree up to a later marker: the snapshot neither
        // repeats nor skips what the live stream delivers after it.
        yield* terminals.write(threadId, terminalId, "echo done-$((1+1))\n");
        const a = (yield* awaitText(first, line("done-2"))).text;
        const b = (yield* awaitText(second, line("done-2"))).text;
        expect(b.slice(0, b.search(line("done-2")))).toBe(a.slice(0, a.search(line("done-2"))));
      }),
    ),
  );

  it.live("resizes the terminal the shell sees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* terminals.resize(threadId, terminalId, 100, 30);
        yield* terminals.write(threadId, terminalId, "stty size\n");
        yield* awaitText(output, line("30 100"));
        const [summary] = yield* terminals.list(threadId);
        expect(summary).toMatchObject({ cols: 100, rows: 30 });
      }),
    ),
  );

  it.live("opens the same id once, resizing it when asked at a new size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, opened } = yield* withTerminal;
        const again = yield* terminals.open({ threadId, terminalId, cols: 120, rows: 40 });
        expect(again.pid).toBe(opened.pid);
        expect(again).toMatchObject({ cols: 120, rows: 40 });
        expect(yield* terminals.list(threadId)).toHaveLength(1);
      }),
    ),
  );

  it.live("holds each thread to its terminal limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        for (let i = 1; i < TERMINALS_PER_THREAD; i++) {
          yield* terminals.open({ threadId, terminalId: makeTerminalId(), ...SIZE });
        }
        const listed = yield* terminals.list(threadId);
        expect(listed).toHaveLength(TERMINALS_PER_THREAD);
        expect(listed[0]!.terminalId).toBe(terminalId);
        expect(
          yield* failureCode(
            terminals.open({ threadId, terminalId: makeTerminalId(), title: "one more", ...SIZE }),
          ),
        ).toBe("conflict");
      }),
    ),
  );

  it.live("keeps an exited shell listed, with its output, until it is closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* terminals.write(threadId, terminalId, "echo bye-$((2*3)); exit 3\n");
        const exited = (yield* awaitKind(output, "exited")).item;
        expect(exited).toEqual({ kind: "exited", exitCode: 3, signal: null });
        yield* output.awaitDone;
        expect((yield* output.collected).at(-1)?.text).toMatch(line("bye-6"));

        const [summary] = yield* terminals.list(threadId);
        expect(summary).toMatchObject({ terminalId, status: "exited", exitCode: 3 });
        // Writing to it is harmless; the terminal is still there to read.
        yield* terminals.write(threadId, terminalId, "echo nobody\n");

        const late = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* late.awaitDone;
        const items = (yield* late.collected).map(({ item }) => item);
        expect(items.map((item) => item.kind)).toEqual(["snapshot", "exited"]);
        expect(items[0]!.kind === "snapshot" && items[0]!.data).toMatch(line("bye-6"));
      }),
    ),
  );

  it.live("close ends the shell and forgets the terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* awaitKind(output, "snapshot");
        yield* terminals.close(threadId, terminalId);
        yield* awaitKind(output, "exited");
        yield* output.awaitDone;
        expect(yield* terminals.list(threadId)).toEqual([]);
        expect(yield* failureCode(terminals.close(threadId, terminalId))).toBe("not-found");
      }),
    ),
  );

  it.live(
    "a close interrupted while the shell ignores SIGHUP still ends it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* buildStack;
          const exits: Array<Deferred.Deferred<PtyExit>> = [];
          const capture: typeof spawnPty = (options) =>
            Effect.tap(spawnPty(options), (pty) =>
              Effect.sync(() => {
                const exit = Deferred.makeUnsafe<PtyExit>();
                pty.onExit((result) => Deferred.doneUnsafe(exit, Effect.succeed(result)));
                exits.push(exit);
              }),
            );
          const terminals = yield* stack.service(yield* Effect.scope, capture);
          const threadId = yield* stack.thread;
          const terminalId = makeTerminalId();
          yield* terminals.open({ threadId, terminalId, ...SIZE });
          const output = yield* watch(terminals.subscribe(threadId, terminalId));
          yield* terminals.write(threadId, terminalId, "trap '' HUP; echo trapped-$((1+1))\n");
          yield* awaitText(output, line("trapped-2"));

          // Started at once, the close runs up to its wait for the exit after
          // SIGHUP; the interrupt then lands where a client's would — and
          // must wait for the SIGKILL rather than cut the kill short.
          const closing = yield* Effect.forkChild(terminals.close(threadId, terminalId), {
            startImmediately: true,
          });
          expect(yield* terminals.list(threadId)).toEqual([]);
          yield* Fiber.interrupt(closing);
          expect(yield* Deferred.isDone(exits[0]!)).toBe(true);
          expect((yield* Deferred.await(exits[0]!)).signal).not.toBeNull();
        }),
      ),
    15_000,
  );

  for (const command of ["thread.delete", "thread.archive"] as const) {
    it.live(`${command} ends that thread's shells and no other's`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine, terminals, threadId, terminalId, thread } = yield* withTerminal;
          const otherThread = yield* thread;
          const otherTerminal = makeTerminalId();
          yield* terminals.open({ threadId: otherThread, terminalId: otherTerminal, ...SIZE });
          const doomed = yield* watch(terminals.subscribe(threadId, terminalId));
          const kept = yield* watch(terminals.subscribe(otherThread, otherTerminal));
          yield* awaitKind(doomed, "snapshot");

          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: command,
            threadId,
          });
          yield* awaitKind(doomed, "exited");
          expect(yield* terminals.list(threadId)).toEqual([]);

          yield* terminals.write(otherThread, otherTerminal, "echo $((40+2))\n");
          yield* awaitText(kept, line("42"));
          const [survivor] = yield* terminals.list(otherThread);
          expect(survivor).toMatchObject({ terminalId: otherTerminal, status: "running" });
        }),
      ),
    );
  }

  it.live("closing the service's scope ends every shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const spawned: Array<PtyProcess> = [];
        const exits: Array<Deferred.Deferred<PtyExit>> = [];
        const capture: typeof spawnPty = (options) =>
          Effect.tap(spawnPty(options), (pty) =>
            Effect.sync(() => {
              const exit = Deferred.makeUnsafe<PtyExit>();
              pty.onExit((result) => Deferred.doneUnsafe(exit, Effect.succeed(result)));
              spawned.push(pty);
              exits.push(exit);
            }),
          );
        const scope = yield* Scope.make();
        const terminals = yield* stack.service(scope, capture);
        const threadId = yield* stack.thread;
        const terminalId = makeTerminalId();
        yield* terminals.open({ threadId, terminalId, ...SIZE });
        const output = yield* watch(terminals.subscribe(threadId, terminalId));
        yield* terminals.write(threadId, terminalId, "echo $((20+22))\n");
        yield* awaitText(output, line("42"));

        yield* Scope.close(scope, Exit.void);
        expect(spawned).toHaveLength(1);
        const exit = yield* Deferred.await(exits[0]!);
        expect(exit.signal).not.toBeNull();
      }),
    ),
  );

  it.live("answers not-found for a terminal that is unknown or another thread's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, thread } = yield* withTerminal;
        const otherThread = yield* thread;
        const unknown = makeTerminalId();
        expect(yield* failureCode(terminals.write(threadId, unknown, "x"))).toBe("not-found");
        expect(yield* failureCode(terminals.resize(threadId, unknown, 80, 24))).toBe("not-found");
        expect(yield* failureCode(terminals.close(threadId, unknown))).toBe("not-found");
        expect(yield* failureCode(Stream.runDrain(terminals.subscribe(threadId, unknown)))).toBe(
          "not-found",
        );
        expect(yield* failureCode(terminals.write(otherThread, terminalId, "x"))).toBe("not-found");
        expect(
          yield* failureCode(terminals.open({ threadId: otherThread, terminalId, ...SIZE })),
        ).toBe("conflict");
      }),
    ),
  );
});

describe("workspaceOf", () => {
  it.live("refuses an archived thread until it is unarchived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        const threadId = yield* stack.thread;
        const toggle = (type: "thread.archive" | "thread.unarchive") =>
          stack.engine
            .dispatch({ commandId: makeCommandId(), createdAt: NOW, type, threadId })
            .pipe(Effect.orDie);
        yield* toggle("thread.archive");
        expect(yield* Effect.flip(resolve(threadId))).toMatchObject({
          code: "invalid",
          message: "the thread is archived; unarchive it to open a terminal",
        });
        yield* toggle("thread.unarchive");
        expect(yield* Effect.orDie(resolve(threadId))).toBe(stack.workspace);
      }),
    ),
  );

  it.live("refuses an unknown thread and a project folder that is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        expect(yield* failureCode(resolve(makeThreadId()))).toBe("not-found");

        const threadId = yield* stack.thread;
        expect(yield* Effect.orDie(resolve(threadId))).toBe(stack.workspace);
        rmSync(stack.workspace, { recursive: true, force: true });
        const error = yield* Effect.flip(resolve(threadId));
        expect(error).toMatchObject({
          code: "invalid",
          message: "the project folder no longer exists",
        });
      }),
    ),
  );
});
