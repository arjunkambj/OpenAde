/**
 * The renderer half of the server-state seam, asserted against a fake channel.
 *
 * Two earlier passes each believed the *other* side of this bridge was the
 * incomplete one, so the members the renderer's `Window["openade"]` type
 * declares are pinned here: all three server-state members exist, the state
 * carries its `connection`, and every subscription hands back an unsubscribe
 * that actually detaches the listener.
 */

import { describe, expect, it } from "vitest";

import { makeOpenAdeBridge, type PreloadIpc, type ServerState } from "./bridge";

type Listener = (event: unknown, ...args: never) => void;

/** Records invokes and lets a test push on a channel, as the main process does. */
const fakeIpc = () => {
  const invokes: Array<{ channel: string; args: ReadonlyArray<unknown> }> = [];
  const listeners = new Map<string, Array<Listener>>();
  const answers = new Map<string, unknown>();
  const ipc: PreloadIpc = {
    invoke: (channel, ...args) => {
      invokes.push({ channel, args });
      return Promise.resolve(answers.get(channel));
    },
    on: (channel, listener) => {
      const existing = listeners.get(channel) ?? [];
      existing.push(listener);
      listeners.set(channel, existing);
    },
    removeListener: (channel, listener) => {
      listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  return {
    ipc,
    invokes,
    answer: (channel: string, value: unknown) => answers.set(channel, value),
    listenerCount: (channel: string) => (listeners.get(channel) ?? []).length,
    push: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) {
        (listener as (event: unknown, payload: unknown) => void)({}, payload);
      }
    },
  };
};

const READY: ServerState = {
  status: "ready",
  connection: { url: "ws://127.0.0.1:4711/ws", token: "t-1", serverInstanceId: "boot-1" },
  attempt: null,
  reason: null,
};

describe("makeOpenAdeBridge", () => {
  it("exposes the three server-state members the renderer type declares", () => {
    const bridge = makeOpenAdeBridge(fakeIpc().ipc);
    expect(typeof bridge.getConnection).toBe("function");
    expect(typeof bridge.getServerState).toBe("function");
    expect(typeof bridge.onServerState).toBe("function");
  });

  it("answers getServerState with the connection the main process published", async () => {
    const fake = fakeIpc();
    fake.answer("openade:server-state:get", READY);
    const state = await makeOpenAdeBridge(fake.ipc).getServerState();
    expect(state).toEqual(READY);
    expect(state.connection?.serverInstanceId).toBe("boot-1");
    expect(fake.invokes).toEqual([{ channel: "openade:server-state:get", args: [] }]);
  });

  it("delivers a restart's fresh connection to an onServerState subscriber", () => {
    const fake = fakeIpc();
    const seen: Array<ServerState> = [];
    const stop = makeOpenAdeBridge(fake.ipc).onServerState((state) => seen.push(state));

    fake.push("openade:server-state", {
      status: "restarting",
      connection: null,
      attempt: 1,
      reason: null,
    });
    const restarted: ServerState = {
      status: "ready",
      connection: { url: "ws://127.0.0.1:5822/ws", token: "t-2", serverInstanceId: "boot-2" },
      attempt: null,
      reason: null,
    };
    fake.push("openade:server-state", restarted);

    expect(seen.map((state) => state.status)).toEqual(["restarting", "ready"]);
    expect(seen[1]?.connection).toEqual(restarted.connection);
    stop();
  });

  it("detaches its own listener on unsubscribe and leaves other subscribers alone", () => {
    const fake = fakeIpc();
    const bridge = makeOpenAdeBridge(fake.ipc);
    const first: Array<ServerState> = [];
    const second: Array<ServerState> = [];
    const stopFirst = bridge.onServerState((state) => first.push(state));
    const stopSecond = bridge.onServerState((state) => second.push(state));
    expect(fake.listenerCount("openade:server-state")).toBe(2);

    stopFirst();
    fake.push("openade:server-state", READY);

    expect(first).toEqual([]);
    expect(second).toEqual([READY]);
    expect(fake.listenerCount("openade:server-state")).toBe(1);
    stopSecond();
    expect(fake.listenerCount("openade:server-state")).toBe(0);
  });

  it("routes the rest of the surface to its own channel", async () => {
    const fake = fakeIpc();
    const bridge = makeOpenAdeBridge(fake.ipc);
    await bridge.openExternal("https://example.test");
    await bridge.pickDirectory();
    await bridge.browserPane.attach("thread-1");
    await bridge.browserPane.detach("thread-1");
    expect(fake.invokes).toEqual([
      { channel: "openade:open-external", args: ["https://example.test"] },
      { channel: "openade:pick-directory", args: [] },
      { channel: "openade:browser-attach", args: ["thread-1"] },
      { channel: "openade:browser-detach", args: ["thread-1"] },
    ]);
  });

  it("hands browser-pane input through with its thread id", () => {
    const fake = fakeIpc();
    const seen: Array<{ threadId: string; input: unknown }> = [];
    const stop = makeOpenAdeBridge(fake.ipc).browserPane.onInput((payload) => seen.push(payload));
    fake.push("openade:browser-input", {
      threadId: "thread-1",
      input: { kind: "click", x: 1, y: 2 },
    });
    stop();
    fake.push("openade:browser-input", { threadId: "thread-1", input: { kind: "key", key: "a" } });
    expect(seen).toEqual([{ threadId: "thread-1", input: { kind: "click", x: 1, y: 2 } }]);
  });
});
