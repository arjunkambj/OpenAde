/**
 * The driver seam: one live browser per thread, opened lazily on first use.
 *
 * `openAgentBrowserDriver` picks the mode per
 * docs/decisions/w6-browser-mode.md:
 *
 * - **cdp-attach** — when `OPENADE_CDP_PORT` is set (the desktop launched us
 *   with remote debugging on a random loopback port), the driver lists CDP
 *   targets through `agent-browser --cdp <port> tab --json` and binds the
 *   pane's webview guest (`--pin-tab`, so a destroyed pane reports `tab_gone`
 *   instead of silently driving another target). The pin lives in the daemon,
 *   which reaps itself when idle, so the driver re-issues it after a gap that
 *   long. Human input lands in the guest directly, so `sendInput` is a no-op
 *   in this mode.
 * - **owned-chromium** — no CDP endpoint, or no webview target inside the
 *   attach window: agent-browser runs its own (headless) Chrome. The driver
 *   connects the session's `stream` WebSocket for live frames and forwards
 *   human input into it.
 *
 * Tests use `makeFakeDriver`, which implements the same interface over an
 * in-memory page — the queue, epoch and teardown logic above it stay real.
 */

import { writeFileSync } from "node:fs";

import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BrowserFrame, BrowserHumanInput } from "@OpenAde/contracts/rpc";

import {
  AGENT_BROWSER_MISSING_MESSAGE,
  AgentBrowser,
  AgentBrowserError,
  AgentBrowserUnavailable,
  IDLE_TIMEOUT_MS,
  sessionNameFor,
  type AgentBrowserSession,
} from "./agentBrowser";
import { connectStream, StreamClientError, type StreamClient } from "./streamClient";

export type BrowserMode = "cdp-attach" | "owned-chromium";

/** What the driver reports back to the session as pages paint and move. */
export interface DriverEvents {
  readonly onFrame: (frame: BrowserFrame) => Effect.Effect<void>;
  readonly onUrl: (url: string) => Effect.Effect<void>;
  /** The owned-mode stream ended — the daemon went away under us. */
  readonly onEnded: () => Effect.Effect<void>;
}

export interface DriverLocation {
  readonly url: string | null;
  readonly title: string | null;
}

export interface BrowserDriver {
  readonly mode: BrowserMode;
  /** One agent-browser call on the bound session/target. */
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<Record<string, unknown>, AgentBrowserError | AgentBrowserUnavailable>;
  /** Human input that must reach the page (pointer/keys/text/scroll only). */
  readonly sendInput: (input: BrowserHumanInput) => Effect.Effect<void, StreamClientError>;
  /** Best-effort url/title read; `null`s when the target is gone. */
  readonly location: Effect.Effect<DriverLocation>;
  /** Tear the session down. Idempotent, never fails. */
  readonly close: Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// cdp-attach

interface CdpTarget {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

const readTargets = (data: Record<string, unknown>): ReadonlyArray<CdpTarget> => {
  const tabs = data.tabs;
  if (!Array.isArray(tabs)) return [];
  const out: Array<CdpTarget> = [];
  for (const tab of tabs) {
    if (typeof tab !== "object" || tab === null) continue;
    const record = tab as Record<string, unknown>;
    if (typeof record.targetId !== "string") continue;
    out.push({
      targetId: record.targetId,
      type: typeof record.type === "string" ? record.type : "",
      url: typeof record.url === "string" ? record.url : "",
    });
  }
  return out;
};

/**
 * Pick the pane's webview guest out of the CDP target list.
 *
 * The pane loads `<attachMarker>` as its first document, which identifies it
 * exactly. After a remount the marker may already be navigated away from, so
 * a *single* webview-typed target also counts. `page` targets are never
 * accepted — one of those is the app's own main window, and binding it would
 * drive our UI.
 */
const pickWebviewTarget = (
  targets: ReadonlyArray<CdpTarget>,
  attachMarker: string,
): Option.Option<CdpTarget> => {
  const webviews = targets.filter((target) => target.type === "webview");
  const marked = webviews.find((target) => target.url.startsWith(attachMarker));
  if (marked !== undefined) return Option.some(marked);
  return webviews.length === 1 ? Option.some(webviews[0]!) : Option.none();
};

/** Takes the driver's own `exec` so a cdp read goes through the pin check. */
const locationOf = (exec: BrowserDriver["exec"]): Effect.Effect<DriverLocation> =>
  Effect.gen(function* () {
    const url = yield* exec(["get", "url"]).pipe(
      Effect.map((data) => (typeof data.url === "string" ? data.url : null)),
      Effect.option,
    );
    const title = yield* exec(["get", "title"]).pipe(
      Effect.map((data) => (typeof data.title === "string" ? data.title : null)),
      Effect.option,
    );
    return {
      url: url._tag === "Some" ? url.value : null,
      title: title._tag === "Some" ? title.value : null,
    };
  });

export interface OpenDriverOptions {
  readonly threadId: string;
  /**
   * Marker-page prefix — `http://127.0.0.1:<port>/browser/attach/<threadId>`.
   * Empty string disables marker matching (single-webview fallback only).
   */
  readonly attachMarker: string;
  readonly events: DriverEvents;
  /** Target-discovery attempts before falling back to owned mode. */
  readonly attachAttempts?: number;
  readonly attachDelayMs?: number;
  /**
   * How long a gap between commands means the daemon may have been reaped,
   * so the cdp driver re-pins its target before the next one. Defaults to the
   * idle timeout `sessionEnvFor` gives the daemon.
   */
  readonly rebindAfterIdleMs?: number;
}

export const openAgentBrowserDriver = (
  options: OpenDriverOptions,
): Effect.Effect<
  BrowserDriver,
  AgentBrowserError | AgentBrowserUnavailable | StreamClientError,
  Scope.Scope | AgentBrowser
> =>
  Effect.gen(function* () {
    const agentBrowser = yield* AgentBrowser;
    if (agentBrowser.binary === null) {
      return yield* new AgentBrowserUnavailable({ message: AGENT_BROWSER_MISSING_MESSAGE });
    }
    const sessionName = sessionNameFor(options.threadId);

    if (agentBrowser.cdpPort !== null) {
      const session = agentBrowser.session(sessionName, { cdpPort: agentBrowser.cdpPort });
      const target = yield* resolveTarget(
        session,
        options.attachMarker,
        options.attachAttempts ?? 12,
        options.attachDelayMs ?? 250,
      );
      if (Option.isSome(target)) {
        yield* session.exec(["--pin-tab", "tab", target.value.targetId]);
        return makeCdpDriver(session, options, target.value.targetId);
      }
      // No pane mounted inside the window — fall through to owned Chromium.
      yield* Effect.logDebug(
        `browser: no webview target on cdp port ${agentBrowser.cdpPort}, using owned chromium`,
      );
    }
    return yield* openOwnedDriver(sessionName, agentBrowser, options);
  });

/** The retry sentinel: the list worked, the pane's guest just is not there yet. */
class TargetNotFound extends Data.TaggedError("TargetNotFound")<Record<string, never>> {}

const resolveTarget = (
  session: AgentBrowserSession,
  attachMarker: string,
  attempts: number,
  delayMs: number,
): Effect.Effect<Option.Option<CdpTarget>> =>
  Effect.gen(function* () {
    const data = yield* session.exec(["tab", "list"]);
    const target = pickWebviewTarget(readTargets(data), attachMarker);
    if (Option.isNone(target)) {
      // A successful list with no webview in it is the case the grace window
      // exists for — the pane's guest has not registered its CDP target yet.
      // Failing here is what makes the schedule retry; the catch below turns
      // an exhausted window into "no pane", which falls back to owned mode.
      return yield* new TargetNotFound({});
    }
    return target.value;
  }).pipe(
    Effect.retry(
      Schedule.recurs(Math.max(0, attempts - 1)).pipe(
        Schedule.addDelay(() => Effect.succeed(`${delayMs} millis` as const)),
      ),
    ),
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<CdpTarget>())),
  );

const makeCdpDriver = (
  session: AgentBrowserSession,
  options: OpenDriverOptions,
  initialTargetId: string,
): BrowserDriver => {
  const boundTarget = { current: initialTargetId };

  const rebind = Effect.gen(function* () {
    const target = yield* resolveTarget(session, options.attachMarker, 4, 200);
    if (Option.isNone(target)) {
      return yield* new AgentBrowserError({
        command: "rebind",
        message: "the browser pane's webview is gone",
        code: "tab_gone",
        data: null,
      });
    }
    yield* session.exec(["--pin-tab", "tab", target.value.targetId]);
    boundTarget.current = target.value.targetId;
  });

  const isTabGone = (error: AgentBrowserError | AgentBrowserUnavailable): boolean =>
    error._tag === "AgentBrowserError" && error.code === "tab_gone";

  // The pin is daemon state, and the daemon reaps itself after an idle spell
  // (`sessionEnvFor` gives cdp sessions the same timeout as owned ones). The
  // next exec would silently resurrect an *unpinned* daemon, which picks its
  // own target on a CDP port that also carries the app's own window — so
  // after a gap that long, re-issue the pin before the command. A pin the
  // target no longer answers fails as `tab_gone`, which the catch below turns
  // into a full rebind.
  const idleMs = options.rebindAfterIdleMs ?? IDLE_TIMEOUT_MS;
  const lastExecAt = { current: null as number | null };
  const now = Effect.clockWith((clock) => clock.currentTimeMillis);

  const repinIfIdle = Effect.gen(function* () {
    const at = yield* now;
    if (lastExecAt.current !== null && at - lastExecAt.current >= idleMs) {
      yield* session.exec(["--pin-tab", "tab", boundTarget.current]).pipe(Effect.ignore);
    }
  });

  const exec: BrowserDriver["exec"] = (argv, execOptions) =>
    repinIfIdle.pipe(
      Effect.andThen(session.exec(argv, execOptions)),
      // The pane unmounted mid-call (or the guest crashed): re-resolve the
      // webview target once and retry, rather than failing the tool call.
      Effect.catchIf(isTabGone, () => Effect.andThen(rebind, session.exec(argv, execOptions))),
      Effect.tap(() => Effect.flatMap(now, (at) => Effect.sync(() => (lastExecAt.current = at)))),
    );

  return {
    mode: "cdp-attach",
    exec,
    // The guest received the input before we did — nothing to forward.
    sendInput: () => Effect.void,
    location: locationOf(exec),
    // The webview belongs to the pane; "closing" the browser is the pane
    // unmounting, and `close` here would destroy a tab the desktop owns. The
    // attachment is released by the daemon's idle timeout instead, which
    // `sessionEnvFor` sets for cdp sessions as well as owned ones — without
    // it an `ade-<threadId>` daemon outlived the thread, the window and the
    // app.
    close: Effect.void,
  };
};

// ---------------------------------------------------------------------------
// owned-chromium

const openOwnedDriver = (
  sessionName: string,
  agentBrowser: AgentBrowser["Service"],
  options: OpenDriverOptions,
): Effect.Effect<
  BrowserDriver,
  AgentBrowserError | AgentBrowserUnavailable | StreamClientError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const session = agentBrowser.session(sessionName, { cdpPort: null });
    // Opens about:blank, which also brings up the daemon and its stream server.
    yield* session.exec(["open"]);
    const status = yield* session.exec(["stream", "status"]);
    const port = status.port;
    let stream: StreamClient | null = null;
    if (typeof port === "number") {
      const client = yield* connectStream(`ws://127.0.0.1:${port}`).pipe(Effect.option);
      if (Option.isSome(client)) {
        stream = client.value;
        const consume = client.value.inbound.pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              if (message.type === "frame" && typeof message.data === "string") {
                const metadata = (message.metadata ?? {}) as Record<string, unknown>;
                yield* options.events.onFrame({
                  mediaType: "image/jpeg",
                  base64: message.data,
                  width: typeof metadata.deviceWidth === "number" ? metadata.deviceWidth : 0,
                  height: typeof metadata.deviceHeight === "number" ? metadata.deviceHeight : 0,
                  capturedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                });
              } else if (message.type === "url" && typeof message.url === "string") {
                yield* options.events.onUrl(message.url);
              }
            }),
          ),
          Effect.andThen(options.events.onEnded()),
          Effect.catch(() => options.events.onEnded()),
        );
        yield* Effect.forkIn(consume, scope);
      }
    }

    const sendInput = (input: BrowserHumanInput): Effect.Effect<void, StreamClientError> => {
      if (stream === null) return Effect.void;
      const client = stream;
      const sendAll = (messages: ReadonlyArray<Record<string, unknown>>) =>
        Effect.forEach(messages, (message) => client.send(message), { discard: true });
      switch (input.kind) {
        case "click":
          return sendAll([
            {
              type: "input_mouse",
              eventType: "mousePressed",
              x: input.x,
              y: input.y,
              button: input.button ?? "left",
              clickCount: 1,
            },
            {
              type: "input_mouse",
              eventType: "mouseReleased",
              x: input.x,
              y: input.y,
              button: input.button ?? "left",
              clickCount: 1,
            },
          ]);
        case "key":
          return sendAll([
            {
              type: "input_keyboard",
              eventType: "keyDown",
              key: input.key,
              code: input.key,
              ...(input.key.length === 1 ? { text: input.key } : {}),
              ...(input.modifiers !== undefined ? { modifiers: [...input.modifiers] } : {}),
            },
            {
              type: "input_keyboard",
              eventType: "keyUp",
              key: input.key,
              code: input.key,
            },
          ]);
        case "text":
          return sendAll([{ type: "input_keyboard", eventType: "char", text: input.text }]);
        case "scroll":
          return sendAll([
            {
              type: "input_mouse",
              eventType: "mouseWheel",
              x: 0,
              y: 0,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            },
          ]);
        default:
          // navigate / history / location are routed through exec by the service.
          return Effect.void;
      }
    };

    return {
      mode: "owned-chromium",
      exec: (argv, execOptions) => session.exec(argv, execOptions),
      sendInput,
      location: locationOf(session.exec),
      close: session.exec(["close"]).pipe(Effect.ignore),
    };
  });

// ---------------------------------------------------------------------------
// fake driver for tests

export interface FakePage {
  url: string;
  title: string;
  /** Snapshot lines; refs map to the url clicking them navigates to. */
  lines: ReadonlyArray<{ role: string; name: string; ref: string; url?: string }>;
  /** Visited entries; `historyIndex` marks the current one. */
  history: Array<{ url: string; title: string }>;
  historyIndex: number;
  /**
   * What `tab list` answers. Defaults to one `page` target for the current
   * url; a test that cares about the cdp-attach target rules sets its own.
   */
  tabs?: ReadonlyArray<{ targetId: string; type: string; url: string }>;
}

/**
 * An in-memory driver speaking the same `exec(argv)` vocabulary — enough for
 * the e2e to prove open/snapshot/click, the queue, interruption and teardown
 * without a browser binary.
 */
export const makeFakeDriver = (
  page: FakePage,
  hooks?: {
    /** Failing here is how a test plays back a daemon error (e.g. `tab_gone`). */
    readonly onExec?: (argv: ReadonlyArray<string>) => Effect.Effect<void, AgentBrowserError>;
    readonly onInput?: (input: BrowserHumanInput) => Effect.Effect<void>;
    readonly onClose?: () => Effect.Effect<void>;
    /** The mode the driver reports; `owned-chromium` unless a test says otherwise. */
    readonly mode?: BrowserMode;
  },
): BrowserDriver => {
  const record = (data: Record<string, unknown>) => ({
    ...data,
    url: page.url,
    title: page.title,
  });

  const navigate = (url: string) => {
    page.history = page.history.slice(0, page.historyIndex + 1);
    page.history.push({ url, title: `Fake ${url}` });
    page.historyIndex = page.history.length - 1;
    page.url = url;
    page.title = `Fake ${url}`;
  };

  const exec = (
    argv: ReadonlyArray<string>,
  ): Effect.Effect<Record<string, unknown>, AgentBrowserError> =>
    Effect.gen(function* () {
      if (hooks?.onExec !== undefined) yield* hooks.onExec(argv);
      const [command, ...rest] = argv;
      switch (command) {
        case "open":
          navigate(String(rest[0] ?? "about:blank"));
          return record({ targetId: "fake-target" });
        case "snapshot": {
          const text = page.lines
            .map((line) => `- ${line.role} "${line.name}" [ref=${line.ref}]`)
            .join("\n");
          return record({
            snapshot: text,
            origin: page.url,
            refs: Object.fromEntries(
              page.lines.map((line) => [line.ref, { name: line.name, role: line.role }]),
            ),
          });
        }
        case "click": {
          const ref = String(rest[0] ?? "");
          const line = page.lines.find(
            (entry) => entry.ref === ref || `@${entry.ref}` === ref || entry.name === ref,
          );
          if (line === undefined) {
            return yield* new AgentBrowserError({
              command: argv.join(" "),
              message: `Could not locate element ${ref}`,
              code: null,
              data: null,
            });
          }
          if (line.url !== undefined) navigate(line.url);
          return record({ clicked: ref });
        }
        case "fill":
        case "type":
        case "keyboard":
        case "press":
        case "scroll":
        case "wait":
        case "eval":
          return record({ ok: true });
        case "get": {
          if (rest[0] === "url") return { url: page.url };
          if (rest[0] === "title") return { title: page.title };
          if (rest[0] === "text") return { text: page.lines.map((l) => l.name).join(" ") };
          return record({ ok: true });
        }
        case "back": {
          if (page.historyIndex > 0) {
            page.historyIndex -= 1;
            const entry = page.history[page.historyIndex]!;
            page.url = entry.url;
            page.title = entry.title;
          }
          return record({ ok: true });
        }
        case "forward": {
          if (page.historyIndex < page.history.length - 1) {
            page.historyIndex += 1;
            const entry = page.history[page.historyIndex]!;
            page.url = entry.url;
            page.title = entry.title;
          }
          return record({ ok: true });
        }
        case "reload":
          return record({ ok: true });
        case "screenshot": {
          // A real file, like the daemon writes — the service inlines it.
          const path = String(rest[0] ?? "");
          writeFileSync(
            path,
            Buffer.from(
              "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
                "1f15c4890000000d4944415478da63fcffff3f0300050201ed0b6b2c0000000049454e44ae426082",
              "hex",
            ),
          );
          return record({ path });
        }
        case "tab":
          return record({
            tabs: page.tabs ?? [{ targetId: "fake-target", type: "page", url: page.url }],
          });
        case "close":
          return record({ closed: true });
        default:
          return record({ ok: true });
      }
    });

  return {
    mode: hooks?.mode ?? "owned-chromium",
    exec,
    sendInput: (input) => (hooks?.onInput ?? (() => Effect.void))(input),
    location: Effect.sync(() => ({ url: page.url, title: page.title })),
    close: hooks?.onClose !== undefined ? hooks.onClose() : Effect.void,
  };
};
