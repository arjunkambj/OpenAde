/**
 * The real `BrowserService` behind the RPC tag in `../rpc/services` —
 * session registry, the serialized per-thread command queue, the
 * human-control epoch and the teardown reactor.
 *
 * A session is a lazy record: `browser.subscribe` creates the state ref but
 * not the browser. The driver (see `./driver`) is opened on the first tool
 * call or human navigation, so opening the pane never launches Chrome.
 *
 * The interrupt rule (spec §12): every session carries an epoch that human
 * input bumps — except input classes an in-flight `browser_*` call is
 * expected to synthesize itself (a `browser_click` produces pointer events
 * over CDP). A call that settles under a different epoch than it started
 * returns `interrupted_by_human`; the harness sees that string in the tool
 * result.
 *
 * Teardown runs on `thread.deleted`/`thread.archived` — the only writer of
 * durable thread state is the engine, so this service listens for its events
 * rather than being called by the session manager. Closing the owned
 * Chromium (or releasing the CDP attachment) plus publishing a final
 * `stopped` state is all it does; token revocation is the MCP gateway's job.
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServer from "effect/unstable/http/HttpServer";

import type { ThreadId } from "@OpenAde/contracts/ids";
import { makeRequestId } from "@OpenAde/contracts/ids";
import type { BrowserFrame, BrowserHumanInput, BrowserState } from "@OpenAde/contracts/rpc";

import { OrchestrationEngine } from "../orchestration/Engine";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { AgentBrowser } from "./agentBrowser";
import { openAgentBrowserDriver, type BrowserDriver, type DriverEvents } from "./driver";
import {
  findBrowserTool,
  type BrowserCallOutcome,
  type InputBudget,
  type InputClass,
  type PreparedCall,
} from "./tools";

const STOPPED_STATUS = "stopped" as const;

interface Session {
  readonly threadId: ThreadId;
  readonly state: SubscriptionRef.SubscriptionRef<BrowserState>;
  readonly epoch: Ref.Ref<number>;
  /** What the in-flight tool may still echo back of its own input, or none. */
  readonly inFlight: Ref.Ref<{
    readonly tool: string;
    readonly expects: InputBudget;
  } | null>;
  readonly queue: Semaphore.Semaphore;
  /** The open driver plus the scope its stream/fibers live under. */
  readonly driver: Ref.Ref<{
    readonly driver: BrowserDriver;
    readonly scope: Scope.Closeable;
  } | null>;
}

/**
 * The daemon's "the tab I was bound to no longer exists". The cdp driver
 * retries a rebind before it surfaces this, so seeing it here means the pane's
 * webview is really gone.
 */
const isTabGone = (error: { readonly message: string; readonly code?: string | null }): boolean =>
  error.code === "tab_gone";

/** Which input epoch-class a human gesture belongs to. */
const inputClassOf = (input: BrowserHumanInput): InputClass | null => {
  switch (input.kind) {
    case "click":
      return "pointer";
    case "key":
    case "text":
      return "key";
    case "scroll":
      return "wheel";
    default:
      return null;
  }
};

const defaultMode = (cdpConfigured: boolean): BrowserState["mode"] =>
  cdpConfigured ? "cdp-attach" : "owned-chromium";

const initialState = (threadId: ThreadId, mode: BrowserState["mode"]): BrowserState => ({
  threadId,
  status: STOPPED_STATUS,
  mode,
  url: null,
  title: null,
  frame: null,
});

/** What the driver seam needs at open time (one per thread). */
export interface OpenDriverOptions {
  readonly threadId: ThreadId;
  readonly attachMarker: string;
  readonly events: DriverEvents;
}

/**
 * The service body, with the driver opener injected so tests can run the
 * whole queue/epoch/teardown path against `fakeBrowserDriver` without
 * touching a real `agent-browser` binary. `cdpAvailable` only seeds the
 * initial `BrowserState.mode` — the driver reports the real mode on open.
 */
export const makeService = (injected: {
  readonly cdpAvailable: boolean;
  readonly openDriver: (
    options: OpenDriverOptions,
  ) => Effect.Effect<BrowserDriver, { readonly message: string }, Scope.Scope>;
}): Effect.Effect<
  BrowserService["Service"],
  never,
  OrchestrationEngine | PermissionService | HttpServer.HttpServer | Scope.Scope
> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const permissions = yield* PermissionService;
    const httpServer = yield* HttpServer.HttpServer;
    const serviceScope = yield* Effect.scope;

    const sessions = yield* Ref.make(new Map<ThreadId, Session>());
    // Serializes session-record creation across threads of the map.
    const registryLock = yield* Semaphore.make(1);

    const attachMarkerFor = (threadId: ThreadId): string => {
      const address = httpServer.address;
      if (typeof address === "object" && address !== null && "port" in address) {
        return `http://127.0.0.1:${address.port}/browser/attach/${threadId}`;
      }
      return "";
    };

    const getSession = (threadId: ThreadId): Effect.Effect<Session> =>
      registryLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = (yield* Ref.get(sessions)).get(threadId);
          if (existing !== undefined) return existing;
          const session: Session = {
            threadId,
            state: yield* SubscriptionRef.make(
              initialState(threadId, defaultMode(injected.cdpAvailable)),
            ),
            epoch: yield* Ref.make(0),
            inFlight: yield* Ref.make<{
              readonly tool: string;
              readonly expects: InputBudget;
            } | null>(null),
            queue: yield* Semaphore.make(1),
            driver: yield* Ref.make<{
              readonly driver: BrowserDriver;
              readonly scope: Scope.Closeable;
            } | null>(null),
          };
          yield* Ref.update(sessions, (map) => new Map(map).set(threadId, session));
          return session;
        }),
      );

    const eventsFor = (session: Session): DriverEvents => ({
      onFrame: (frame: BrowserFrame) =>
        SubscriptionRef.update(session.state, (state) => ({ ...state, frame })),
      onUrl: (url: string) => SubscriptionRef.update(session.state, (state) => ({ ...state, url })),
      // The stream ended — daemon restart or crash. exec() resurrects the
      // daemon on the next call; frames just pause until then.
      onEnded: () =>
        SubscriptionRef.update(session.state, (state) => ({
          ...state,
          frame: null,
        })),
    });

    const ensureDriver = (session: Session): Effect.Effect<BrowserDriver, BrowserCallOutcome> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(session.driver);
        if (current !== null) return current.driver;

        yield* SubscriptionRef.update(session.state, (state) => ({
          ...state,
          status: "starting" as const,
          message: undefined,
        }));

        const scope = yield* Scope.make();
        const opened = yield* Scope.use(scope)(
          injected.openDriver({
            threadId: session.threadId,
            attachMarker: attachMarkerFor(session.threadId),
            events: eventsFor(session),
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void);
              yield* SubscriptionRef.update(session.state, (state) => ({
                ...state,
                status: "error" as const,
                message: error.message,
              }));
              return yield* Effect.fail<BrowserCallOutcome>({
                kind: "error",
                message: error.message,
              });
            }),
          ),
        );

        yield* Ref.set(session.driver, { driver: opened, scope });
        yield* SubscriptionRef.update(session.state, (state) => ({
          ...state,
          status: "ready" as const,
          mode: opened.mode,
        }));
        return opened;
      });

    const releaseDriver = (session: Session): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.getAndSet(session.driver, null);
        if (current !== null) {
          yield* current.driver.close;
          yield* Scope.close(current.scope, Exit.void);
        }
      });

    /** Re-read url/title after calls that can move the page. */
    const refreshLocation = (session: Session, driver: BrowserDriver): Effect.Effect<void> =>
      driver.location.pipe(
        Effect.flatMap(({ url, title }) =>
          SubscriptionRef.update(session.state, (state) => ({
            ...state,
            url: url ?? state.url,
            title: title ?? state.title,
          })),
        ),
        Effect.ignore,
      );

    /**
     * A human address-bar navigation: mirror the url immediately so the
     * toolbar stops fighting the field, then move the page and re-read where
     * it actually landed.
     */
    const navigateWith = (
      session: Session,
      driver: BrowserDriver,
      url: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(session.state, (state) => ({ ...state, url }));
        yield* driver.exec(["open", url]).pipe(Effect.ignore);
        yield* refreshLocation(session, driver);
      });

    /** `browser_eval` carries the `web` approval kind — denied in plan mode. */
    const gateEval = (
      threadId: ThreadId,
      args: unknown,
    ): Effect.Effect<BrowserCallOutcome | null> =>
      Effect.gen(function* () {
        const doc = yield* engine.threadDoc(threadId).pipe(Effect.orElseSucceed(() => null));
        const decision = yield* permissions
          .decide({
            request: {
              requestId: makeRequestId(),
              kind: "web",
              toolName: "mcp__openade__browser_eval",
              input: typeof args === "object" && args !== null ? args : {},
              description: "evaluate JavaScript in the thread's browser",
            },
            runtimeMode: doc?.settings.runtimeMode ?? "approval-required",
            interactionMode: doc?.settings.interactionMode ?? "default",
            threadId,
          })
          .pipe(Effect.orElseSucceed((): "prompt" => "prompt"));
        if (decision === "deny") {
          return {
            kind: "error",
            message: "browser_eval is denied by the thread's current permission mode",
          };
        }
        // "prompt" reaches us after the harness-side PreToolUse approval, and
        // "allow" is a rule the user set — either way the call may run.
        return null;
      });

    const screenshotPath = () =>
      join(tmpdir(), `openade-shot-${Math.random().toString(16).slice(2)}.png`);

    const execOnce = (driver: BrowserDriver, argv: ReadonlyArray<string>) =>
      driver.exec(argv).pipe(
        Effect.map((data) => ({ ok: true as const, data })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );

    const runCall = (
      session: Session,
      call: PreparedCall,
    ): Effect.Effect<BrowserCallOutcome, never, never> =>
      session.queue.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const epoch = yield* Ref.get(session.epoch);
            yield* Ref.set(session.inFlight, { tool: call.name, expects: call.expects });
            yield* SubscriptionRef.update(session.state, (state) => ({
              ...state,
              activeTool: call.name,
            }));
            return epoch;
          }),
          (epoch) =>
            Effect.gen(function* () {
              const ensured = yield* ensureDriver(session).pipe(
                Effect.map((driver) => ({ ok: true as const, driver })),
                Effect.catch((outcome) => Effect.succeed({ ok: false as const, outcome })),
              );
              if (!ensured.ok) return ensured.outcome;
              let driver = ensured.driver;
              const argv = call.screenshot
                ? call.argv.map((part) => (part === "{shot}" ? screenshotPath() : part))
                : call.argv;
              let executed = yield* execOnce(driver, argv);
              if (!executed.ok && isTabGone(executed.error)) {
                // The pane's webview is gone for good — the cdp driver already
                // tried to rebind. Drop the dead driver so the next open can
                // fall back to owned Chromium, and give this call that chance
                // rather than erroring every call until the thread is deleted.
                yield* releaseDriver(session);
                const reopened = yield* ensureDriver(session).pipe(
                  Effect.map((next) => ({ ok: true as const, driver: next })),
                  Effect.catch((outcome) => Effect.succeed({ ok: false as const, outcome })),
                );
                if (!reopened.ok) return reopened.outcome;
                driver = reopened.driver;
                executed = yield* execOnce(driver, argv);
              }
              if (!executed.ok) {
                return {
                  kind: "error",
                  message: executed.error.message,
                } satisfies BrowserCallOutcome;
              }
              const data = executed.data;

              if (call.mutating) yield* refreshLocation(session, driver);

              const epochAfter = yield* Ref.get(session.epoch);
              if (epochAfter !== epoch) {
                return { kind: "interrupted", status: "interrupted_by_human" } as const;
              }

              let image: { data: string; mediaType: string } | undefined;
              if (call.screenshot && typeof data.path === "string") {
                const bytes = yield* Effect.promise(() => readFile(String(data.path))).pipe(
                  Effect.option,
                );
                if (Option.isSome(bytes)) {
                  image = { data: bytes.value.toString("base64"), mediaType: "image/png" };
                  yield* Effect.promise(() => unlink(String(data.path))).pipe(Effect.ignore);
                }
              }
              return { kind: "ok", data, ...(image === undefined ? {} : { image }) } as const;
            }),
          () =>
            Effect.andThen(
              Ref.set(session.inFlight, null),
              SubscriptionRef.update(session.state, (state) => ({ ...state, activeTool: null })),
            ),
        ),
      );

    const callTool = (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ): Effect.Effect<BrowserCallOutcome> =>
      Effect.gen(function* () {
        const spec = findBrowserTool(name);
        if (spec === undefined) {
          return {
            kind: "error",
            message: `unknown browser tool: ${name}`,
          } satisfies BrowserCallOutcome;
        }
        const prepared = spec.prepare(args);
        if (!prepared.ok) {
          return { kind: "error", message: prepared.error } satisfies BrowserCallOutcome;
        }
        if (name === "browser_eval") {
          const denied = yield* gateEval(threadId, args);
          if (denied !== null) return denied;
        }
        const session = yield* getSession(threadId);
        return yield* runCall(session, prepared.call);
      });

    const humanInput = (threadId: ThreadId, input: BrowserHumanInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);

        if (input.kind === "location") {
          yield* SubscriptionRef.update(session.state, (state) => ({
            ...state,
            url: input.url,
            title: input.title ?? state.title,
          }));
          return;
        }

        // Human control: bump the epoch unless an in-flight call expected to
        // synthesize this input itself. The expectation is a per-class budget
        // sized by the call — one pointer event for a `browser_click`, one
        // key event per character for a `browser_type`. Gestures beyond the
        // budget are the human taking over, and do interrupt.
        const inputClass = inputClassOf(input);
        const expected = yield* Ref.modify(session.inFlight, (current) => {
          const remaining =
            current === null || inputClass === null ? 0 : (current.expects.get(inputClass) ?? 0);
          if (current === null || inputClass === null || remaining <= 0) {
            return [false, current] as const;
          }
          const next = new Map(current.expects);
          if (remaining === 1) next.delete(inputClass);
          else next.set(inputClass, remaining - 1);
          return [true, { ...current, expects: next }] as const;
        });
        if (!expected) {
          yield* Ref.update(session.epoch, (epoch) => epoch + 1);
        }

        const current = yield* Ref.get(session.driver);
        if (current === null) {
          // No browser yet. A navigate is enough reason to start one, and so
          // is a reload — that is the pane's "try again" after a failed open.
          // Back and forward are not: there is no history to move through, and
          // starting a browser for them would pop a window and do nothing.
          if (
            input.kind === "navigate" ||
            (input.kind === "history" && input.direction === "reload")
          ) {
            yield* session.queue.withPermits(1)(
              Effect.gen(function* () {
                const ensured = yield* Effect.option(ensureDriver(session));
                if (Option.isSome(ensured) && input.kind === "navigate") {
                  yield* navigateWith(session, ensured.value, input.url);
                }
              }),
            );
          }
          return;
        }
        const driver = current.driver;

        // The toolbar drives the page in both modes. In cdp-attach the driver
        // is bound to the pane's own guest target, so `open`/`back`/`forward`/
        // `reload` move exactly the webview the human is looking at — the pane
        // itself has no navigation path of its own.
        switch (input.kind) {
          case "click":
          case "key":
          case "text":
          case "scroll":
            yield* driver.sendInput(input).pipe(Effect.ignore);
            return;
          case "navigate":
            yield* session.queue.withPermits(1)(navigateWith(session, driver, input.url));
            return;
          case "history":
            yield* session.queue.withPermits(1)(
              driver
                .exec(
                  input.direction === "back"
                    ? ["back"]
                    : input.direction === "forward"
                      ? ["forward"]
                      : ["reload"],
                )
                .pipe(Effect.ignore)
                .pipe(Effect.andThen(refreshLocation(session, driver))),
            );
            return;
          default:
            return;
        }
      });

    const teardown = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = (yield* Ref.get(sessions)).get(threadId);
        if (session === undefined) return;
        yield* releaseDriver(session);
        yield* SubscriptionRef.set(session.state, {
          ...initialState(session.threadId, defaultMode(injected.cdpAvailable)),
          status: STOPPED_STATUS,
        });
        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
      }).pipe(Effect.ignore);

    // Thread close tears the browser down — deleted or archived.
    //
    // The subscription is opened here rather than inside the forked fiber: a
    // PubSub drops what it publishes while nobody is listening, and a forked
    // fiber does not start until this one yields. Subscribing first means no
    // thread.deleted can slip through the gap between build and first tick.
    //
    // Its lifetime is the consumer's, not the service's: the PubSub is
    // unbounded, so a subscription nobody drains retains every event forever.
    // The reactor's own scope closes it whether it ends or is interrupted.
    const reactorScope = yield* Scope.make();
    const events = yield* Scope.provide(reactorScope)(engine.subscribeEvents);
    const reactor = Stream.runForEach(Stream.fromSubscription(events), (event) =>
      event.type === "thread.deleted" || event.type === "thread.archived"
        ? teardown(event.streamId as ThreadId)
        : Effect.void,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser teardown reactor ended", error)),
      Effect.ensuring(Scope.close(reactorScope, Exit.void)),
    );
    yield* Effect.forkIn(reactor, serviceScope);

    return BrowserService.of({
      subscribe: (threadId) =>
        Stream.unwrap(
          Effect.map(getSession(threadId), (session) => SubscriptionRef.changes(session.state)),
        ),
      humanInput,
      callTool,
      teardown,
    });
  });

export const layer: Layer.Layer<
  BrowserService,
  never,
  OrchestrationEngine | PermissionService | AgentBrowser | HttpServer.HttpServer
> = Layer.effect(
  BrowserService,
  Effect.gen(function* () {
    const agentBrowser = yield* AgentBrowser;
    return yield* makeService({
      cdpAvailable: agentBrowser.cdpPort !== null,
      openDriver: (options) =>
        openAgentBrowserDriver(options).pipe(Effect.provideService(AgentBrowser, agentBrowser)),
    });
  }),
);
