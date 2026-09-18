/**
 * The path the spec's cleanup rule names: the engine emits `thread.deleted`
 * and the forked reactor removes the directory. Nothing calls `purge()` by
 * hand, and archiving a thread leaves its files alone.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { utimes } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeCommandId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { AttachmentReactor } from "./AttachmentReactor";
import { AttachmentStore } from "./AttachmentStore";

const NOW = "2026-01-02T03:04:05.000Z";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_BASE64 = Buffer.from(
  Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]),
).toString("base64");

/** Yields until the sweep's forked fiber has removed `path`; never a timer. */
const awaitGone = (path: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (!existsSync(path)) {
        return true;
      }
      yield* Effect.yieldNow;
    }
    return false;
  });

/**
 * Engine and store without the reactor, so a test can seed threads and files
 * first and then build the reactor — which is what a boot over an existing
 * `~/.openade` actually looks like.
 */
const buildBase = Effect.gen(function* () {
  const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "openade-sweep-"));
  const storeContext = yield* Layer.build(AttachmentStore.layerAt(root));
  const store = Layer.succeed(AttachmentStore, Context.get(storeContext, AttachmentStore));
  const sqliteContext = yield* Layer.build(sqliteTestLayer());
  const sqlite = Layer.succeedContext(sqliteContext);
  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const engineLayer = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const engineContext = yield* Layer.build(engineLayer);
  return {
    root,
    engine: Context.get(engineContext, OrchestrationEngine),
    store: Context.get(storeContext, AttachmentStore),
    /** What the composition root builds after everything else is in place. */
    startReactor: Layer.build(
      AttachmentReactor.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeedContext(engineContext), store)),
      ),
    ),
  };
});

/**
 * The real store with a latch on `purge`, so a test awaits the reactor's own
 * work instead of sleeping until it has probably happened.
 */
const buildStack = Effect.gen(function* () {
  const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "openade-reactor-"));
  const purged = yield* Deferred.make<ThreadId>();
  const storeContext = yield* Layer.build(AttachmentStore.layerAt(root));
  const real = Context.get(storeContext, AttachmentStore);
  const store = Layer.succeed(
    AttachmentStore,
    AttachmentStore.of({
      ...real,
      purge: (threadId) =>
        real.purge(threadId).pipe(Effect.andThen(Deferred.succeed(purged, threadId))),
    }),
  );

  const sqliteContext = yield* Layer.build(sqliteTestLayer());
  const sqlite = Layer.succeedContext(sqliteContext);
  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const context = yield* Layer.build(
    Layer.mergeAll(
      engine,
      store,
      AttachmentReactor.pipe(Layer.provide(Layer.mergeAll(engine, store))),
    ),
  );
  return {
    engine: Context.get(context, OrchestrationEngine),
    store: Context.get(context, AttachmentStore),
    purged,
  };
});

const makeThread = (engine: OrchestrationEngine["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectId = makeProjectId();
    yield* engine.dispatch({
      commandId: makeCommandId(),
      createdAt: NOW,
      type: "project.create",
      projectId,
      name: "demo",
      workspaceRoot: `/repo/${projectId}`,
    });
    yield* engine.dispatch({
      commandId: makeCommandId(),
      createdAt: NOW,
      type: "thread.create",
      threadId,
      projectId,
      settings: { model: "fake/model" },
    });
  });

describe("AttachmentReactor", () => {
  it.live("deleting a thread removes what it staged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, store, purged } = yield* buildStack;
        const threadId = makeThreadId();
        yield* makeThread(engine, threadId);

        const staged = yield* store.stage({
          threadId,
          name: "shot.png",
          base64: PNG_BASE64,
        });
        expect((yield* store.read(threadId, staged.path)).size).toBe(70);

        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId,
        });
        expect(yield* Deferred.await(purged)).toBe(threadId);

        const gone = yield* Effect.exit(store.read(threadId, staged.path));
        expect(gone._tag).toBe("Failure");
      }),
    ),
  );

  it.live("keeps an archived thread's attachments — it can still be reopened", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, store, purged } = yield* buildStack;
        const archived = makeThreadId();
        yield* makeThread(engine, archived);
        const staged = yield* store.stage({
          threadId: archived,
          name: "shot.png",
          base64: PNG_BASE64,
        });

        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.archive",
          threadId: archived,
        });

        // Delete a second thread and wait for *its* purge: by the time the
        // reactor has handled an event published after the archive, it has
        // certainly handled the archive too — and it did nothing with it.
        const doomed = makeThreadId();
        yield* makeThread(engine, doomed);
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId: doomed,
        });
        expect(yield* Deferred.await(purged)).toBe(doomed);

        expect((yield* store.read(archived, staged.path)).size).toBe(70);
      }),
    ),
  );

  it.live("a boot reclaims a staged file whose turn was never sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The composer stages before it dispatches. A paste whose turn never
        // happened — the window closed, the send failed, the server died — was
        // referenced by nothing and kept for the life of the thread, and
        // nothing in the product ever listed or removed it.
        const { engine, store, startReactor } = yield* buildBase;
        const threadId = makeThreadId();
        yield* makeThread(engine, threadId);

        const sent = yield* store.stage({ threadId, name: "sent.png", base64: PNG_BASE64 });
        const abandoned = yield* store.stage({
          threadId,
          name: "abandoned.png",
          base64: GIF_BASE64,
        });
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.turn.start",
          threadId,
          text: "what is in this picture?",
          attachments: [{ path: sent.path, mime: sent.mime }],
          mentions: [],
          queued: false,
        });
        // Both files are older than the window the sweep leaves alone.
        for (const path of [sent.path, abandoned.path]) {
          const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
          yield* Effect.promise(() => utimes(path, old, old));
        }

        yield* startReactor;
        yield* awaitGone(abandoned.path);

        expect(existsSync(sent.path)).toBe(true);
        expect(existsSync(abandoned.path)).toBe(false);
      }),
    ),
  );

  it.live("leaves a file young enough to be an upload in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, store, startReactor } = yield* buildBase;
        const threadId = makeThreadId();
        yield* makeThread(engine, threadId);
        const fresh = yield* store.stage({ threadId, name: "fresh.png", base64: PNG_BASE64 });

        yield* startReactor;
        // The sweep runs on a forked fiber; give it more turns than it needs
        // and then assert it left the file alone.
        for (let i = 0; i < 50; i++) {
          yield* Effect.yieldNow;
        }
        expect(existsSync(fresh.path)).toBe(true);
      }),
    ),
  );
});
