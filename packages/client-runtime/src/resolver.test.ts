/**
 * The resolution order the brief fixes: the Electron preload first, then the
 * dev Vite endpoint, then `?server=&token=` — and `null` when no channel
 * answers, which is what makes the renderer mountable with no server at all.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveConnection, type DesktopServerState, type ResolvedConnection } from "./resolver";

interface Channels {
  readonly preload?: ResolvedConnection | null;
  readonly serverState?: DesktopServerState;
  readonly devEndpoint?: ResolvedConnection | null;
  readonly search?: string;
}

/**
 * Installs the three channels as globals for one call. `resolver.ts` reads
 * them at call time, so nothing needs resetting between assertions beyond
 * this teardown.
 */
const withChannels = async <A>(channels: Channels, run: () => Promise<A>): Promise<A> => {
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousFetch = globals.fetch;
  globals.window = {
    location: { search: channels.search ?? "" },
    ...(channels.preload === undefined && channels.serverState === undefined
      ? {}
      : {
          openade: {
            ...(channels.preload === undefined
              ? {}
              : { getConnection: () => Promise.resolve(channels.preload) }),
            ...(channels.serverState === undefined
              ? {}
              : { getServerState: () => Promise.resolve(channels.serverState) }),
          },
        }),
  };
  globals.fetch =
    channels.devEndpoint === undefined
      ? () => Promise.reject(new Error("no dev server"))
      : () =>
          Promise.resolve({
            ok: channels.devEndpoint !== null,
            json: () => Promise.resolve(channels.devEndpoint),
          });
  try {
    return await run();
  } finally {
    globals.window = previousWindow;
    globals.fetch = previousFetch;
  }
};

const PRELOAD = { url: "ws://127.0.0.1:1/ws", token: "preload", serverInstanceId: "boot-1" };
const DEV = { url: "ws://127.0.0.1:2/ws", token: "dev", serverInstanceId: "boot-2" };
const RESTARTED = { url: "ws://127.0.0.1:9/ws", token: "restarted", serverInstanceId: "boot-9" };

describe("resolveConnection", () => {
  it.effect("prefers the preload over every other channel", () =>
    Effect.promise(() =>
      withChannels(
        { preload: PRELOAD, devEndpoint: DEV, search: "?server=ws://3/ws&token=params" },
        async () => expect(await resolveConnection()).toEqual(PRELOAD),
      ),
    ),
  );

  it.effect("falls through to the dev endpoint when the preload has nothing", () =>
    Effect.promise(() =>
      withChannels(
        { preload: null, devEndpoint: DEV, search: "?server=ws://3/ws&token=params" },
        async () => expect(await resolveConnection()).toEqual(DEV),
      ),
    ),
  );

  it.effect("falls through to the search params when the dev endpoint 404s", () =>
    Effect.promise(() =>
      withChannels(
        { devEndpoint: null, search: "?server=ws://127.0.0.1:3/ws&token=params" },
        async () =>
          expect(await resolveConnection()).toEqual({
            url: "ws://127.0.0.1:3/ws",
            token: "params",
          }),
      ),
    ),
  );

  it.effect("answers null when no channel is configured", () =>
    Effect.promise(() =>
      withChannels({ search: "" }, async () => expect(await resolveConnection()).toBeNull()),
    ),
  );

  it.effect("ignores a dev endpoint body that is missing a field", () =>
    Effect.promise(() =>
      withChannels({ devEndpoint: { url: "ws://4/ws" } as ResolvedConnection }, async () =>
        expect(await resolveConnection()).toBeNull(),
      ),
    ),
  );

  it("prefers the supervisor's live state over its plain connection getter", () =>
    withChannels(
      {
        preload: PRELOAD,
        serverState: { status: "ready", connection: RESTARTED },
      },
      // After a restart `getConnection` can still be answering with the dead
      // server's port and token; the supervisor state is the fresh one.
      async () => expect(await resolveConnection()).toEqual(RESTARTED),
    ));

  it("falls back to getConnection while the server has no connection yet", () =>
    withChannels(
      { preload: PRELOAD, serverState: { status: "restarting", connection: null } },
      async () => expect(await resolveConnection()).toEqual(PRELOAD),
    ));
});
