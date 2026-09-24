/**
 * The driver seam: one live browser per thread, opened lazily on the first
 * agent call. `BrowserService` talks only to this interface.
 *
 * Two drivers implement it, one per mode the server can run in:
 *
 * - `./inAppDriver` — the desktop: agent-browser drives the thread's own pane
 *   webviews through the shell's browser bridge.
 * - `./ownedDriver` — no desktop (the web renderer): agent-browser runs its
 *   own headless Chrome and streams JPEG frames to the pane.
 *
 * There is no path from one to the other. A desktop whose attach fails
 * reports the failure; it never quietly opens a headless browser instead.
 *
 * Tests use `./fakeDriver`, which implements the same interface over an
 * in-memory page — the queue, epoch and teardown logic above it stay real.
 */

import * as Effect from "effect/Effect";

import type { BrowserFrame, BrowserHumanInput } from "@poseidon/contracts/rpc";

import type { AgentBrowserError, AgentBrowserUnavailable } from "./agentBrowser";
import type { StreamClientError } from "./streamClient";

/** The browser a driver runs; `BrowserState.mode` adds `disabled`, which has none. */
export type DriverMode = "in-app" | "owned-chromium";

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
  readonly mode: DriverMode;
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

/** One entry of `tab list` / `tab new`, as the CLI reports it. */
export interface ListedTab {
  readonly targetId: string;
  readonly url: string;
}

/** The tabs of a `tab list` result, in the order the CLI listed them. */
export const readTabs = (data: Record<string, unknown>): ReadonlyArray<ListedTab> => {
  const tabs = data.tabs;
  if (!Array.isArray(tabs)) return [];
  const out: Array<ListedTab> = [];
  for (const tab of tabs) {
    if (typeof tab !== "object" || tab === null) continue;
    const record = tab as Record<string, unknown>;
    if (typeof record.targetId !== "string") continue;
    out.push({
      targetId: record.targetId,
      url: typeof record.url === "string" ? record.url : "",
    });
  }
  return out;
};

/** Takes the driver's own `exec`, so an in-app read goes through its attach. */
export const locationOf = (exec: BrowserDriver["exec"]): Effect.Effect<DriverLocation> =>
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
