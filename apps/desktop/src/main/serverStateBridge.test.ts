/**
 * The seam from the supervisor to `window.openade`, with both `electron` ends
 * faked. What is pinned here is what the renderer's reconnect depends on: the
 * pulled state and the pushed state are the same shape, `ready` carries the
 * connection, and a restart publishes the *new* port, token and instance id
 * rather than the boot-time ones.
 */

import { describe, expect, it } from "vitest";

import type { ServerState } from "../backend/ServerSupervisor";

import {
  CONNECTION_CHANNEL,
  SERVER_STATE_GET_CHANNEL,
  SERVER_STATE_PUSH_CHANNEL,
  registerServerStateBridge,
  type ServerStateSource,
} from "./serverStateBridge";

const BOOT = { url: "ws://127.0.0.1:4711/ws", token: "t-1", serverInstanceId: "boot-1" };
const RESTARTED = { url: "ws://127.0.0.1:5822/ws", token: "t-2", serverInstanceId: "boot-2" };

/** A supervisor stand-in whose state a test moves by hand. */
const fakeSupervisor = (initial: ServerState) => {
  let state = initial;
  const listeners: Array<(next: ServerState) => void> = [];
  const source: ServerStateSource = {
    get current() {
      return state;
    },
    get connection() {
      return state.status === "ready" ? state.connection : null;
    },
    on: (_event, listener) => listeners.push(listener),
  };
  return {
    source,
    move: (next: ServerState) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
};

const fakeChannel = () => {
  const handlers = new Map<string, () => unknown>();
  const windows: Array<{
    sent: Array<{ channel: string; payload: unknown }>;
    send: (channel: string, payload: unknown) => void;
  }> = [];
  const openWindow = () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      sent,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    };
    windows.push(win);
    return win;
  };
  return {
    channel: {
      handle: (name: string, handler: () => unknown) => handlers.set(name, handler),
      senders: () => windows,
    },
    invoke: (name: string) => handlers.get(name)?.(),
    handled: () => [...handlers.keys()],
    openWindow,
  };
};

describe("registerServerStateBridge", () => {
  it("registers both pull channels", () => {
    const fake = fakeChannel();
    registerServerStateBridge(fake.channel, fakeSupervisor({ status: "starting" }).source);
    expect(fake.handled()).toEqual([CONNECTION_CHANNEL, SERVER_STATE_GET_CHANNEL]);
  });

  it("answers a late window with the current state, connection and all", () => {
    const fake = fakeChannel();
    const supervisor = fakeSupervisor({ status: "ready", connection: BOOT });
    registerServerStateBridge(fake.channel, supervisor.source);
    expect(fake.invoke(SERVER_STATE_GET_CHANNEL)).toEqual({
      status: "ready",
      connection: BOOT,
      attempt: null,
      reason: null,
    });
    expect(fake.invoke(CONNECTION_CHANNEL)).toEqual(BOOT);
  });

  it("publishes a restart's fresh credentials to every open window", () => {
    const fake = fakeChannel();
    const supervisor = fakeSupervisor({ status: "ready", connection: BOOT });
    registerServerStateBridge(fake.channel, supervisor.source);
    const first = fake.openWindow();
    const second = fake.openWindow();

    supervisor.move({ status: "restarting", attempt: 1 });
    supervisor.move({ status: "ready", connection: RESTARTED });

    const expected = [
      {
        channel: SERVER_STATE_PUSH_CHANNEL,
        payload: { status: "restarting", connection: null, attempt: 1, reason: null },
      },
      {
        channel: SERVER_STATE_PUSH_CHANNEL,
        payload: { status: "ready", connection: RESTARTED, attempt: null, reason: null },
      },
    ];
    expect(first.sent).toEqual(expected);
    expect(second.sent).toEqual(expected);
    // The pull channel agrees with the push, so which way a renderer asked
    // cannot change the credentials it reconnects with.
    expect(fake.invoke(SERVER_STATE_GET_CHANNEL)).toEqual(expected[1]?.payload);
  });

  it("carries the give-up reason so the banner can stop promising a retry", () => {
    const fake = fakeChannel();
    const supervisor = fakeSupervisor({ status: "starting" });
    registerServerStateBridge(fake.channel, supervisor.source);
    const win = fake.openWindow();

    supervisor.move({ status: "failed", reason: "server exited 3 times" });

    expect(win.sent).toEqual([
      {
        channel: SERVER_STATE_PUSH_CHANNEL,
        payload: {
          status: "failed",
          connection: null,
          attempt: null,
          reason: "server exited 3 times",
        },
      },
    ]);
    expect(fake.invoke(CONNECTION_CHANNEL)).toBeNull();
  });

  it("reads the window list per transition, so a window opened later still gets pushes", () => {
    const fake = fakeChannel();
    const supervisor = fakeSupervisor({ status: "starting" });
    registerServerStateBridge(fake.channel, supervisor.source);

    supervisor.move({ status: "restarting", attempt: 1 });
    const late = fake.openWindow();
    supervisor.move({ status: "ready", connection: BOOT });

    expect(late.sent.map((entry) => (entry.payload as { status: string }).status)).toEqual([
      "ready",
    ]);
  });
});
