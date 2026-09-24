/**
 * The live browser proof against a real `agent-browser` daemon + Chrome for
 * Testing — owned-chromium mode (no Electron CDP in a test process).
 *
 * Gated on `POSEIDON_LIVE_BROWSER=1`: it spawns a real browser, so it is
 * opt-in rather than part of the default suite. Verified locally:
 * navigate → snapshot → click, the state stream tracking the page, and
 * teardown closing the owned Chromium.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeThreadId } from "@poseidon/contracts/ids";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { AgentBrowser } from "./agentBrowser";
import { makeService } from "./BrowserService";
import { openOwnedDriver } from "./ownedDriver";

const LIVE = process.env.POSEIDON_LIVE_BROWSER === "1";
const threadId = makeThreadId();

const permissionsStub = Layer.succeed(
  PermissionService,
  PermissionService.of({
    decide: () => Effect.succeed("allow" as const),
    rules: () => Effect.succeed([]),
    addRule: () => Effect.void,
  }),
);

const buildStack = () =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const browser = Layer.effect(
      BrowserService,
      makeService({
        mode: "owned-chromium",
        openDriver: ({ threadId: id, events }) =>
          Effect.gen(function* () {
            const agentBrowser = yield* AgentBrowser;
            return yield* openOwnedDriver(agentBrowser.session(id), events);
          }).pipe(Effect.provide(AgentBrowser.layer)),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(engine, permissionsStub)));
    const context = yield* Layer.build(Layer.mergeAll(engine, browser));
    return { browser: Context.get(context, BrowserService) };
  });

describe.skipIf(!LIVE)("BrowserService (live agent-browser)", () => {
  it.live(
    "open → snapshot → title → teardown on a real Chrome",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { browser } = yield* buildStack();

          const open = yield* browser.callTool(threadId, "browser_open", {
            url: "https://example.com",
          });
          expect(open.kind).toBe("ok");

          const state = yield* Stream.runHead(browser.subscribe(threadId));
          expect(Option.isSome(state) && state.value.status).toBe("ready");
          expect(Option.isSome(state) && state.value.mode).toBe("owned-chromium");
          expect(Option.isSome(state) && state.value.url).toBe("https://example.com/");

          const snapshot = yield* browser.callTool(threadId, "browser_snapshot", {});
          expect(snapshot.kind).toBe("ok");
          if (snapshot.kind === "ok") {
            expect(String(snapshot.data.snapshot)).toContain("Example Domain");
          }

          const title = yield* browser.callTool(threadId, "browser_get", {
            what: "title",
          });
          expect(title.kind).toBe("ok");
          if (title.kind === "ok") {
            expect(title.data.title).toBe("Example Domain");
          }

          yield* browser.teardown(threadId);
          const stopped = yield* Stream.runHead(browser.subscribe(threadId));
          expect(Option.isSome(stopped) && stopped.value.status).toBe("stopped");
        }),
      ),
    60_000,
  );
});
