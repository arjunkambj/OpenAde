/**
 * The path the spec's cleanup rule names: the engine emits `thread.deleted`
 * and the forked reactor removes the directory. Nothing calls `purge()` by
 * hand, and archiving a thread leaves its files alone.
 */

import { mkdtempSync } from "node:fs";
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
});
