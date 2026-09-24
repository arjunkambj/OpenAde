import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeTabsChannel,
  TAB_REQUEST_CHANNEL,
  WINDOW_NOT_OPEN,
  type TabRequest,
  type TabsWindow,
} from "./tabsChannel";

type Sent = { readonly channel: string; readonly payload: { id: number } & TabRequest };

const fakeWindow = (id = 7) => {
  const sent: Array<Sent> = [];
  let destroyed = false;
  const window: TabsWindow = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  return { window, sent, destroy: () => (destroyed = true) };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("makeTabsChannel", () => {
  it("fails at once, clearly, when no window is open", async () => {
    const channel = makeTabsChannel({ window: () => null });
    await expect(channel.create("t1", "about:blank", true)).rejects.toThrow(WINDOW_NOT_OPEN);

    const closed = fakeWindow();
    closed.destroy();
    const stale = makeTabsChannel({ window: () => closed.window });
    await expect(stale.select(3)).rejects.toThrow(WINDOW_NOT_OPEN);
    expect(closed.sent).toEqual([]);
  });

  it("fails clearly when the window does not answer in time", async () => {
    const win = fakeWindow();
    const channel = makeTabsChannel({ window: () => win.window, timeoutMs: 500 });
    const creating = channel.create("t1", "https://example.com/", false);
    const failed = expect(creating).rejects.toThrow(`${WINDOW_NOT_OPEN} (no answer within 500 ms)`);
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    // A late answer is ignored rather than resolving anything.
    channel.answer(win.window.id, { id: win.sent[0]?.payload.id, ok: true, wcId: 9 });
  });

  it("sends each request with its own id and matches answers by id", async () => {
    const win = fakeWindow();
    const channel = makeTabsChannel({ window: () => win.window });
    const first = channel.create("t1", "https://a.test/", false);
    const second = channel.create("t1", "about:blank", true);
    expect(win.sent.map((entry) => entry.channel)).toEqual([
      TAB_REQUEST_CHANNEL,
      TAB_REQUEST_CHANNEL,
    ]);
    const [a, b] = win.sent.map((entry) => entry.payload);
    expect(a).toEqual({
      id: a?.id,
      op: "create",
      threadId: "t1",
      url: "https://a.test/",
      background: false,
    });
    expect(a?.id).not.toBe(b?.id);

    // Answered out of order.
    channel.answer(win.window.id, { id: b?.id, ok: true, wcId: 22 });
    channel.answer(win.window.id, { id: a?.id, ok: true, wcId: 11 });
    await expect(first).resolves.toBe(11);
    await expect(second).resolves.toBe(22);
  });

  it("passes the window's error through and ignores answers from anyone else", async () => {
    const win = fakeWindow(7);
    const channel = makeTabsChannel({ window: () => win.window });
    const closing = channel.close(4);
    const id = win.sent[0]?.payload.id;
    expect(win.sent[0]?.payload).toEqual({ id, op: "close", wcId: 4 });

    channel.answer(8, { id, ok: true });
    channel.answer(win.window.id, "garbage");
    channel.answer(win.window.id, { id, ok: false, error: "no such tab" });
    await expect(closing).rejects.toThrow("no such tab");
  });

  it("refuses a create answer that names no tab", async () => {
    const win = fakeWindow();
    const channel = makeTabsChannel({ window: () => win.window });
    const creating = channel.create("t1", "about:blank", true);
    channel.answer(win.window.id, { id: win.sent[0]?.payload.id, ok: true });
    await expect(creating).rejects.toThrow(/did not say which/);
  });

  it("fails everything waiting on a window that went away", async () => {
    const win = fakeWindow();
    const channel = makeTabsChannel({ window: () => win.window });
    const selecting = channel.select(5);
    channel.abandon(win.window.id);
    await expect(selecting).rejects.toThrow(WINDOW_NOT_OPEN);
  });
});
