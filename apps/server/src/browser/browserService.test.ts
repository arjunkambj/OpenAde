/**
 * The W6 service proof over `makeFakeDriver` — no browser binary needed:
 *
 * - `browser_open → browser_snapshot → browser_click` walks a fake page and
 *   the subscribe stream tracks the url.
 * - A human gesture during an in-flight `browser_eval` resolves the call as
 *   `interrupted` — the epoch flip the MCP layer maps to
 *   `interrupted_by_human`.
 * - A pointer gesture during an in-flight `browser_click` is the agent's own
 *   echo (the call `expects` pointer input) and does NOT interrupt.
 * - A `tab_gone` the cdp driver could not rebind drops the dead driver and
 *   retries the call on a fresh one instead of erroring for the rest of the
 *   thread.
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
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { makeThreadId } from "@OpenAde/contracts/ids";

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
) => Effect.Effect<BrowserDriver, { readonly message: string }, never>;

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
    return { browser: Context.get(context, BrowserService) };
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
