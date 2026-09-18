/**
 * The W6 service proof over `makeFakeDriver` — no browser binary needed:
 *
 * - `browser_open → browser_snapshot → browser_click` walks a fake page and
 *   the subscribe stream tracks the url.
 * - A human gesture during an in-flight `browser_eval` resolves the call as
 *   `interrupted` — the epoch flip the MCP layer maps to
 *   `interrupted_by_human`.
 * - A pointer gesture during an in-flight `browser_click` is the agent's own
 *   echo (the call `expects` pointer input) and does NOT interrupt, and a
 *   `browser_type` survives one echoed keystroke per character of its text.
 * - A `tab_gone` the cdp driver could not rebind drops the dead driver and
 *   retries the call on a fresh one instead of erroring for the rest of the
 *   thread.
 * - A thread.delete dispatched through the engine reaches the teardown
 *   reactor and closes the driver.
 * - `teardown` stops the session and is idempotent.
 * - Sessions are per-thread.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { makeCommandId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { AgentBrowserError } from "./agentBrowser";
import { makeFakeDriver, type FakePage } from "./driver";
import { makeService, type OpenDriverOptions } from "./BrowserService";
import type { BrowserDriver } from "./driver";

const threadId = makeThreadId();
const NOW = "2026-01-02T03:04:05.000Z";

const fakePage = (): FakePage => ({
  url: "about:blank",
  title: "Blank",
  lines: [{ role: "link", name: "Docs", ref: "e1", url: "https://example.com/docs" }],
  history: [],
  historyIndex: -1,
});

const permissionsStub = Layer.succeed(
  PermissionService,
  PermissionService.of({
    decide: () => Effect.succeed("allow" as const),
    rules: () => Effect.succeed([]),
    addRule: () => Effect.void,
  }),
);

const httpStub = Layer.succeed(
  HttpServer.HttpServer,
  HttpServer.make({
    serve: () => Effect.void,
    address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 0 },
  }),
);

type OpenDriver = (
  options: OpenDriverOptions,
) => Effect.Effect<BrowserDriver, { readonly message: string }, Scope.Scope>;

const buildStack = (openDriver: OpenDriver) =>
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
      makeService({ cdpAvailable: false, openDriver }),
    ).pipe(Layer.provide(Layer.mergeAll(engine, permissionsStub, httpStub)));
    const context = yield* Layer.build(Layer.mergeAll(engine, browser));
    return {
      browser: Context.get(context, BrowserService),
      engine: Context.get(context, OrchestrationEngine),
    };
  });

const currentState = (browser: BrowserService["Service"], id: typeof threadId) =>
  Stream.runHead(browser.subscribe(id)).pipe(
    Effect.map((head) => (Option.isSome(head) ? head.value : null)),
  );

describe("BrowserService", () => {
  it.live("open → snapshot → click drives a fake page and tracks the url", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser } = yield* buildStack(() => Effect.succeed(makeFakeDriver(fakePage())));

        const open = yield* browser.callTool(threadId, "browser_open", {
          url: "https://example.com",
        });
        expect(open.kind).toBe("ok");

        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("ready");
        expect(state?.mode).toBe("owned-chromium");
        expect(state?.url).toBe("https://example.com");

        const snapshot = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(snapshot.kind).toBe("ok");
        if (snapshot.kind === "ok") {
          expect(String(snapshot.data.snapshot)).toContain("Docs");
        }

        const click = yield* browser.callTool(threadId, "browser_click", {
          selector: "@e1",
        });
        expect(click.kind).toBe("ok");

        const after = yield* currentState(browser, threadId);
        expect(after?.url).toBe("https://example.com/docs");
        expect(after?.activeTool).toBeFalsy();
      }),
    ),
  );

  it.live("a human gesture mid-call resolves the tool as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "eval"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            }),
          ),
        );

        const call = yield* browser
          .callTool(threadId, "browser_eval", { js: "1 + 1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        // eval expects no pointer input — this click is the human.
        yield* browser.humanInput(threadId, { kind: "click", x: 3, y: 4 });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("interrupted");
      }),
    ),
  );

  it.live("the agent's own input echo does not interrupt its call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "click"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            }),
          ),
        );

        const call = yield* browser
          .callTool(threadId, "browser_click", { selector: "@e1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        // browser_click expects pointer — this gesture is its own echo.
        yield* browser.humanInput(threadId, { kind: "click", x: 3, y: 4 });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("ok");
      }),
    ),
  );

  it.live("a second gesture of the expected class is the human, not the echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "click"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            }),
          ),
        );

        const call = yield* browser
          .callTool(threadId, "browser_click", { selector: "@e1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        // The first click is the call's own echo; the expectation is spent.
        yield* browser.humanInput(threadId, { kind: "click", x: 3, y: 4 });
        // The second is somebody clicking the page while the agent works.
        yield* browser.humanInput(threadId, { kind: "click", x: 5, y: 6 });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("interrupted");
      }),
    ),
  );

  it.live("typing echoes one key per character and still settles as ok", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "keyboard"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            }),
          ),
        );

        const text = "hello";
        const call = yield* browser
          .callTool(threadId, "browser_type", { text })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        // The desktop relay reports every synthesized keystroke back to us.
        for (const key of text) {
          yield* browser.humanInput(threadId, { kind: "key", key });
        }
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("ok");
      }),
    ),
  );

  it.live("sends the agent's browser only to http and https", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `browser_open` took any string, so `file://` plus `browser_get text
        // body` read key material that `read_file` on the same path prompts
        // about — and nothing gated it the way `browser_eval` is gated.
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );

        for (const url of [
          "file:///Users/someone/.ssh/id_ed25519",
          "about:blank",
          "data:text/html,<script>fetch('/')</script>",
          "devtools://devtools/bundled/inspector.html",
        ]) {
          const refused = yield* browser.callTool(threadId, "browser_open", { url });
          expect(refused.kind).toBe("error");
          expect(refused.kind === "error" ? refused.message : "").toContain("http://");
        }
        const refusedTab = yield* browser.callTool(threadId, "browser_tabs", {
          action: "new",
          url: "file:///etc/passwd",
        });
        expect(refusedTab.kind).toBe("error");

        // Refused before anything ran, and the web still works.
        expect(argvs).toEqual([]);
        const opened = yield* browser.callTool(threadId, "browser_open", {
          url: "https://example.com/docs",
        });
        expect(opened.kind).toBe("ok");
        expect(argvs).toContainEqual(["open", "https://example.com/docs"]);
      }),
    ),
  );

  it.live("in cdp-attach mode the pane's webview is the only tab there is", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The CDP port the session attaches to is the app's *own* remote
        // debugging port: one of the `page` targets on it is the OpenAde
        // window. The driver refuses to bind anything but the pane's webview
        // for that reason, and `browser_tabs` used to walk straight around it —
        // `list` named the app's window and `switch` rebound the session to it,
        // which put snapshot, click and eval inside our own UI.
        const argvs: Array<ReadonlyArray<string>> = [];
        const page: FakePage = {
          ...fakePage(),
          tabs: [
            { targetId: "t-webview", type: "webview", url: "https://example.com/" },
            { targetId: "t-app", type: "page", url: "openade://app/t/thread" },
          ],
        };
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(page, {
              mode: "cdp-attach",
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );

        const listed = yield* browser.callTool(threadId, "browser_tabs", { action: "list" });
        expect(listed.kind).toBe("ok");
        expect(listed.kind === "ok" ? listed.data.tabs : null).toEqual([
          { targetId: "t-webview", type: "webview", url: "https://example.com/" },
        ]);

        for (const args of [
          { action: "switch", tab: "t-app" },
          { action: "close", tab: "t-app" },
          { action: "new", url: "https://example.com/" },
        ]) {
          const refused = yield* browser.callTool(threadId, "browser_tabs", args);
          expect(refused.kind).toBe("error");
          expect(refused.kind === "error" ? refused.message : "").toContain(
            "tab management is unavailable",
          );
        }
        // Not merely filtered on the way back: the command never ran.
        expect(argvs.filter((argv) => argv[0] === "tab")).toEqual([["tab", "list"]]);
      }),
    ),
  );

  it.live("owned chromium is ours alone, so tab management still works there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );
        const switched = yield* browser.callTool(threadId, "browser_tabs", {
          action: "switch",
          tab: "t2",
        });
        expect(switched.kind).toBe("ok");
        expect(argvs).toContainEqual(["tab", "t2"]);
      }),
    ),
  );

  it.live("the toolbar drives the attached webview in cdp-attach mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              mode: "cdp-attach",
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );

        // One agent call opens the driver; the toolbar then takes over.
        yield* browser.callTool(threadId, "browser_snapshot", {});
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/a" });
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/b" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "back" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });

        // The commands reached the bound guest instead of being swallowed.
        expect(argvs).toContainEqual(["open", "https://example.com/a"]);
        expect(argvs).toContainEqual(["open", "https://example.com/b"]);
        expect(argvs).toContainEqual(["back"]);
        expect(argvs).toContainEqual(["reload"]);

        // `back` walked the page off the address the human typed last, and
        // the state followed the page rather than the toolbar's optimism.
        const state = yield* currentState(browser, threadId);
        expect(state?.url).toBe("https://example.com/a");
      }),
    ),
  );

  it.live("a lost webview guest falls back instead of bricking the thread", () =>
    Effect.gen(function* () {
      let opened = 0;
      const { browser } = yield* buildStack(() =>
        Effect.sync(() => {
          opened += 1;
          const gone = opened === 1;
          return makeFakeDriver(fakePage(), {
            mode: gone ? "cdp-attach" : "owned-chromium",
            onExec: () =>
              gone
                ? new AgentBrowserError({
                    command: "rebind",
                    message: "the browser pane's webview is gone",
                    code: "tab_gone",
                    data: null,
                  })
                : Effect.void,
          });
        }),
      );

      const first = yield* browser.callTool(threadId, "browser_open", {
        url: "https://example.com",
      });
      // The dead attachment was dropped and the call retried on a fresh
      // driver — which, with no pane to attach to, is owned Chromium.
      expect(first.kind).toBe("ok");
      expect(opened).toBe(2);

      const state = yield* currentState(browser, threadId);
      expect(state?.mode).toBe("owned-chromium");

      // And the session keeps working from there.
      const second = yield* browser.callTool(threadId, "browser_snapshot", {});
      expect(second.kind).toBe("ok");
      expect(opened).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live("the driver's scope outlives the call that opened it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Stands in for the owned driver's frame-stream fiber: it is forked
        // into the open scope, so closing that scope at the end of the open
        // would kill the stream before a single frame arrived.
        let released = false;
        const { browser } = yield* buildStack(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                released = true;
              }),
            );
            return makeFakeDriver(fakePage());
          }),
        );

        yield* browser.callTool(threadId, "browser_open", { url: "https://example.com/a" });
        expect(released).toBe(false);

        yield* browser.teardown(threadId);
        expect(released).toBe(true);
      }),
    ),
  );

  it.live("teardown stops the session and is idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onClose: () =>
                Effect.sync(() => {
                  closes += 1;
                }),
            }),
          ),
        );

        yield* browser.callTool(threadId, "browser_open", { url: "https://example.com" });
        yield* browser.teardown(threadId);

        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("stopped");
        expect(state?.url).toBeNull();
        expect(closes).toBe(1);

        yield* browser.teardown(threadId);
        expect(closes).toBe(1);
      }),
    ),
  );

  it.live("deleting the thread closes its browser through the engine's events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const { browser, engine } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), { onClose: () => Deferred.succeed(closed, undefined) }),
          ),
        );

        const projectId = makeProjectId();
        const ownThread = makeThreadId();
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "project.create",
          projectId,
          name: "demo",
          workspaceRoot: "/repo",
        });
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId: ownThread,
          projectId,
          settings: { model: "fake/model" },
        });

        yield* browser.callTool(ownThread, "browser_open", { url: "https://example.com" });

        // The teardown path: the engine emits thread.deleted and the forked
        // reactor tears the browser down. No
        // one calls teardown() by hand.
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId: ownThread,
        });
        yield* Deferred.await(closed);

        // The driver closed; the published state settles a moment later, so
        // wait for the stopped frame rather than sampling.
        const state = yield* Stream.runHead(
          browser.subscribe(ownThread).pipe(Stream.filter((next) => next.status === "stopped")),
        );
        expect(Option.isSome(state)).toBe(true);
      }),
    ),
  );

  it.live("sessions are per-thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const other = makeThreadId();
        const { browser } = yield* buildStack(() => Effect.succeed(makeFakeDriver(fakePage())));

        yield* browser.callTool(threadId, "browser_open", { url: "https://a.example" });
        const untouched = yield* currentState(browser, other);
        expect(untouched?.status).toBe("stopped");
        expect(untouched?.url).toBeNull();
      }),
    ),
  );
});
