/**
 * The browser pane's payloads on the wire: its state and frames, a person's
 * gestures, the dev servers the address bar suggests and the browser tool's
 * status. `rpc.ts` re-exports every one, so importers keep reading them from
 * `@OpenAde/contracts/rpc`.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ThreadId } from "./ids";

/**
 * What the browser pane shows. `in-app` (the desktop) drives the thread's own
 * pane webviews, so there is no frame to ship; `owned-chromium` (no desktop)
 * runs its own headless browser and streams JPEG frames, which is why `frame`
 * is nullable rather than two separate state shapes; `disabled` is a desktop
 * started with `OPENADE_REMOTE_DEBUG=0`, which has no browser at all.
 *
 * `BrowserState` is wire-only — the server publishes it on `browser.subscribe`
 * and never writes it to the event log — so changing `mode` needs no decoding
 * default for old rows.
 */
export const BrowserFrame = Schema.Struct({
  mediaType: NonEmptyString,
  base64: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
  capturedAt: IsoDateTime,
});
export type BrowserFrame = typeof BrowserFrame.Type;

export const BrowserState = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["stopped", "starting", "ready", "error"]),
  mode: Schema.Literals(["in-app", "owned-chromium", "disabled"]),
  url: Schema.NullOr(NonEmptyString),
  title: Schema.NullOr(Schema.String),
  frame: Schema.NullOr(BrowserFrame),
  /**
   * The `browser_*` tool currently executing, if one is — the pane's
   * "agent is driving" indicator. `null` once the call settles.
   */
  activeTool: Schema.optional(Schema.NullOr(NonEmptyString)),
  message: Schema.optional(Schema.String),
});
export type BrowserState = typeof BrowserState.Type;

/** A person taking over the browser the agent is driving. */
export const BrowserHumanInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    key: NonEmptyString,
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["alt", "ctrl", "meta", "shift"]))),
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    deltaX: Schema.Number,
    deltaY: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("navigate"), url: NonEmptyString }),
  /**
   * Toolbar back/forward/reload/stop — a human gesture that interrupts the
   * agent. `stop` only ever comes from the in-app pane, which alone knows a
   * page is loading.
   */
  Schema.Struct({
    kind: Schema.Literal("history"),
    direction: Schema.Literals(["back", "forward", "reload", "stop"]),
  }),
  /**
   * Passive location sync: the pane observed a navigation (whoever caused it)
   * and reports where the page actually is. Never marks human control.
   */
  Schema.Struct({
    kind: Schema.Literal("location"),
    url: NonEmptyString,
    title: Schema.optional(Schema.String),
  }),
]);
export type BrowserHumanInput = typeof BrowserHumanInput.Type;

/**
 * A local dev server `browser.discoverServers` found for a thread's project:
 * a loopback or wildcard listener whose process runs under the project's
 * folder and answers HTTP with a page or a redirect. `url` is always
 * `http://localhost:<port>`, the address a dev server prints; `processName`
 * is null when the server could not tell whose port it is (no `lsof`), and
 * the pane shows the port alone.
 */
export const DevServer = Schema.Struct({
  url: NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  processName: Schema.NullOr(NonEmptyString),
});
export type DevServer = typeof DevServer.Type;

/**
 * What the server's browser tool is, for the Browser settings page: the one
 * mode it runs in for its life, and whether the `agent-browser` CLI answered
 * `--version` at startup (with what it printed).
 */
export const BrowserToolStatus = Schema.Struct({
  mode: Schema.Literals(["in-app", "owned-chromium", "disabled"]),
  installed: Schema.Boolean,
  version: Schema.NullOr(NonEmptyString),
});
export type BrowserToolStatus = typeof BrowserToolStatus.Type;

/** The most servers one `browser.discoverServers` answer carries. */
export const DEV_SERVER_LIMIT = 16;
