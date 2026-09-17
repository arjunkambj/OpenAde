/**
 * The cdp-attach target handshake, over a fake `agent-browser` CLI.
 *
 * The pane's `<webview>` registers its CDP target a moment after the guest is
 * created, so the driver's attach window has to survive a `tab list` that
 * comes back with no webview in it. Losing that race silently downgrades the
 * thread to owned Chromium — the pane unmounts the live view and switches to
 * the JPEG stream — so the window is worth a test.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentBrowser, type AgentBrowserSession } from "./agentBrowser";
import { openAgentBrowserDriver } from "./driver";

const MARKER = "http://127.0.0.1:7777/browser/attach/thread-1";

/**
 * A CLI that reports no webview for the first `emptyLists` `tab list` calls
 * and the pane's guest from then on. `null` never reports one at all.
 */
const fakeCli = (emptyLists: number | null) => {
  const calls: Array<ReadonlyArray<string>> = [];
  let lists = 0;
  const session = (name: string): AgentBrowserSession => ({
    session: name,
    exec: (argv) =>
      Effect.sync(() => {
        calls.push(argv);
        if (argv[0] === "tab" && argv[1] === "list") {
          lists += 1;
          const ready = emptyLists !== null && lists > emptyLists;
          return {
            tabs: ready ? [{ targetId: "guest-1", type: "webview", url: `${MARKER}` }] : [],
          };
        }
        return {};
      }),
  });
  const layer = Layer.succeed(
    AgentBrowser,
    AgentBrowser.of({
      binary: "agent-browser",
      version: "0.0.0-fake",
      cdpPort: 7777,
      session,
    }),
  );
  return { calls, layer, lists: () => lists };
};

const open = (cli: ReturnType<typeof fakeCli>) =>
  Effect.scoped(
    openAgentBrowserDriver({
      threadId: "thread-1",
      attachMarker: MARKER,
      events: { onFrame: () => Effect.void, onUrl: () => Effect.void, onEnded: () => Effect.void },
      attachAttempts: 5,
      attachDelayMs: 1,
    }),
  ).pipe(Effect.provide(cli.layer));

describe("openAgentBrowserDriver", () => {
  it.live("waits out the attach window for a webview that is not listed yet", () =>
    Effect.gen(function* () {
      const cli = fakeCli(2);
      const driver = yield* open(cli);
      expect(driver.mode).toBe("cdp-attach");
      // It really retried rather than accepting the first empty list.
      expect(cli.lists()).toBe(3);
      expect(cli.calls).toContainEqual(["--pin-tab", "tab", "guest-1"]);
    }),
  );

  it.live("falls back to owned chromium when the window runs out", () =>
    Effect.gen(function* () {
      const cli = fakeCli(null);
      const driver = yield* open(cli);
      expect(driver.mode).toBe("owned-chromium");
      // Every attempt was spent before giving up on the pane.
      expect(cli.lists()).toBe(5);
      expect(cli.calls).toContainEqual(["open"]);
    }),
  );

  it.live("reports the install prompt when the binary is missing", () =>
    Effect.gen(function* () {
      const missing = Layer.succeed(
        AgentBrowser,
        AgentBrowser.of({
          binary: null,
          version: null,
          cdpPort: null,
          session: (name) => ({ session: name, exec: () => Effect.succeed({}) }),
        }),
      );
      const exit = yield* Effect.scoped(
        openAgentBrowserDriver({
          threadId: "thread-1",
          attachMarker: "",
          events: {
            onFrame: () => Effect.void,
            onUrl: () => Effect.void,
            onEnded: () => Effect.void,
          },
        }),
      ).pipe(Effect.provide(missing), Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});
