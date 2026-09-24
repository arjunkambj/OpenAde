import { describe, expect, it } from "vitest";

import {
  INPUT_CHANNEL,
  keyInput,
  makeGuestInputRelay,
  mouseInput,
  type GuestInputPayload,
  type KeyLike,
  type MouseLike,
  type RelayHost,
} from "./guestInput";

const fakeHost = () => {
  const received: Array<GuestInputPayload> = [];
  let destroyed = false;
  const host: RelayHost = {
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      expect(channel).toBe(INPUT_CHANNEL);
      received.push(payload);
    },
  };
  return { host, received, destroy: () => (destroyed = true) };
};

/** A guest webContents: listeners accumulate the way Electron's do. */
const fakeGuest = (id: number, host: () => RelayHost | null) => {
  const keys: Array<(input: KeyLike) => void> = [];
  const mice: Array<(mouse: MouseLike) => void> = [];
  return {
    guest: {
      id,
      onKey: (listener: (input: KeyLike) => void) => keys.push(listener),
      onMouse: (listener: (mouse: MouseLike) => void) => mice.push(listener),
      host,
    },
    key: (input: KeyLike) => keys.forEach((listener) => listener(input)),
    mouse: (mouse: MouseLike) => mice.forEach((listener) => listener(mouse)),
  };
};

describe("makeGuestInputRelay", () => {
  it("tags every gesture with the guest's thread and webContents id", () => {
    const window = fakeHost();
    const relay = makeGuestInputRelay();
    const tab = fakeGuest(41, () => window.host);
    relay.hook(tab.guest, "thread-1");

    tab.mouse({ type: "mouseDown", x: 3, y: 4, button: "left" });
    tab.key({ type: "keyDown", key: "a", modifiers: ["shift"] });
    tab.mouse({ type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: -120 });

    expect(window.received).toEqual([
      { threadId: "thread-1", wcId: 41, input: { kind: "click", x: 3, y: 4, button: "left" } },
      { threadId: "thread-1", wcId: 41, input: { kind: "key", key: "a", modifiers: ["shift"] } },
      { threadId: "thread-1", wcId: 41, input: { kind: "scroll", deltaX: 0, deltaY: -120 } },
    ]);
  });

  it("does not double-report when a remounted pane brings a new guest", () => {
    const window = fakeHost();
    const relay = makeGuestInputRelay();
    const first = fakeGuest(1, () => window.host);
    relay.hook(first.guest, "thread-1");
    relay.forget(1);

    // A remount builds a new guest; hooking it — even twice — reports once.
    const second = fakeGuest(2, () => window.host);
    relay.hook(second.guest, "thread-1");
    relay.hook(second.guest, "thread-1");
    second.mouse({ type: "mouseDown", x: 1, y: 1 });

    expect(window.received).toEqual([
      { threadId: "thread-1", wcId: 2, input: { kind: "click", x: 1, y: 1 } },
    ]);
  });

  it("sends to the embedder of the moment, and to nobody once it is gone", () => {
    const before = fakeHost();
    const after = fakeHost();
    let current: RelayHost | null = before.host;
    const relay = makeGuestInputRelay();
    const tab = fakeGuest(5, () => current);
    relay.hook(tab.guest, "thread-1");

    tab.key({ type: "keyDown", key: "x" });
    current = after.host;
    tab.key({ type: "keyDown", key: "y" });
    after.destroy();
    tab.key({ type: "keyDown", key: "z" });
    current = null;
    tab.key({ type: "keyDown", key: "w" });

    expect(before.received.map((payload) => payload.input)).toEqual([{ kind: "key", key: "x" }]);
    expect(after.received.map((payload) => payload.input)).toEqual([{ kind: "key", key: "y" }]);
  });
});

describe("keyInput and mouseInput", () => {
  it("report keyDown only, with modifiers normalized and deduplicated", () => {
    expect(keyInput({ type: "keyUp", key: "a" })).toBeNull();
    expect(keyInput({ type: "char", key: "a" })).toBeNull();
    expect(
      keyInput({ type: "keyDown", key: "k", modifiers: ["control", "ctrl", "cmd", "capslock"] }),
    ).toEqual({ kind: "key", key: "k", modifiers: ["ctrl", "meta"] });
  });

  it("report presses and wheels, not moves", () => {
    expect(mouseInput({ type: "mouseMove", x: 1, y: 1 })).toBeNull();
    expect(mouseInput({ type: "mouseUp", x: 1, y: 1 })).toBeNull();
    expect(mouseInput({ type: "contextMenu", x: 2, y: 3, button: "right" })).toEqual({
      kind: "click",
      x: 2,
      y: 3,
      button: "right",
    });
    expect(mouseInput({ type: "mouseWheel", x: 0, y: 0 })).toEqual({
      kind: "scroll",
      deltaX: 0,
      deltaY: 0,
    });
  });
});
