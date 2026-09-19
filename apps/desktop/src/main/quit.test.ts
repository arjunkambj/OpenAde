import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeQuitHandler, type QuitEvent } from "./quit";

const DEADLINE_MS = 15_000;

const harness = () => {
  const calls = { prevented: 0, waiting: 0, exits: 0 };
  let release: (() => void) | null = null;
  const handler = makeQuitHandler({
    stopServer: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    onWaiting: () => {
      calls.waiting += 1;
    },
    exit: () => {
      calls.exits += 1;
    },
    deadlineMs: DEADLINE_MS,
  });
  const event: QuitEvent = {
    preventDefault: () => {
      calls.prevented += 1;
    },
  };
  return {
    calls,
    event,
    quit: () => handler(event),
    /** The server child finally exits. */
    serverGone: async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
};

describe("makeQuitHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the quit open until the server child is gone", async () => {
    const { calls, quit, serverGone } = harness();
    quit();

    expect(calls.prevented).toBe(1);
    expect(calls.waiting).toBe(1);
    // The old handler let Electron exit here, orphaning the child.
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(calls.exits).toBe(0);

    await serverGone();
    expect(calls.exits).toBe(1);
  });

  it("exits anyway once the deadline passes, so a wedged server cannot block the quit", async () => {
    const { calls, quit } = harness();
    quit();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(calls.exits).toBe(1);
  });

  it("exits once, not twice, when the child exits after the deadline", async () => {
    const { calls, quit, serverGone } = harness();
    quit();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await serverGone();
    expect(calls.exits).toBe(1);
  });

  it("lets a second quit through to Electron instead of preventing it again", () => {
    const { calls, quit } = harness();
    quit();
    quit();

    expect(calls.prevented).toBe(1);
    expect(calls.waiting).toBe(1);
  });

  it("leaves no timer behind once the child has exited", async () => {
    const { calls, quit, serverGone } = harness();
    quit();
    await serverGone();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS * 2);
    expect(calls.exits).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
