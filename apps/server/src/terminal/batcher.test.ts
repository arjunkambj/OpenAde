import { TERMINAL_BATCH_CHARS, TERMINAL_BATCH_MS } from "@poseidon/contracts/terminal";
import { describe, expect, it } from "vitest";

import { type BatchScheduler, makeBatcher } from "./batcher";

/** A scheduler whose time moves only when the test says so. */
const manualScheduler = () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  const scheduler: BatchScheduler = {
    set: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { scheduler, advance, pending: () => timers.size };
};

const setup = (options: { readonly maxChars?: number; readonly delayMs?: number } = {}) => {
  const clock = manualScheduler();
  const flushed: Array<string> = [];
  const batcher = makeBatcher({
    flush: (data) => flushed.push(data),
    scheduler: clock.scheduler,
    ...options,
  });
  return { batcher, flushed, clock };
};

describe("makeBatcher", () => {
  it("holds output back until the delay after the first chunk, then sends it as one", () => {
    const { batcher, flushed, clock } = setup({ delayMs: 16 });
    batcher.push("a");
    clock.advance(10);
    batcher.push("b");
    batcher.push("c");
    expect(flushed).toEqual([]);
    clock.advance(6);
    expect(flushed).toEqual(["abc"]);
    expect(clock.pending()).toBe(0);
  });

  it("starts a new batch after a timed flush", () => {
    const { batcher, flushed, clock } = setup({ delayMs: 16 });
    batcher.push("one");
    clock.advance(16);
    batcher.push("two");
    expect(flushed).toEqual(["one"]);
    clock.advance(16);
    expect(flushed).toEqual(["one", "two"]);
  });

  it("sends a batch the moment it is full, and never a larger one", () => {
    const { batcher, flushed, clock } = setup({ maxChars: 4, delayMs: 16 });
    batcher.push("ab");
    batcher.push("cdefghij");
    expect(flushed).toEqual(["abcd", "efgh"]);
    clock.advance(16);
    expect(flushed).toEqual(["abcd", "efgh", "ij"]);
  });

  it("stops its timer when a full batch leaves nothing pending", () => {
    const { batcher, flushed, clock } = setup({ maxChars: 4 });
    batcher.push("ab");
    expect(clock.pending()).toBe(1);
    batcher.push("cd");
    expect(flushed).toEqual(["abcd"]);
    expect(clock.pending()).toBe(0);
  });

  it("does not split a surrogate pair across batches", () => {
    const { batcher, flushed } = setup({ maxChars: 4 });
    batcher.push("abc😀de");
    expect(flushed).toEqual(["abc", "😀de"]);
  });

  it("drains on demand, so the last output can go out before an exit", () => {
    const { batcher, flushed, clock } = setup();
    batcher.push("last words");
    batcher.drain();
    expect(flushed).toEqual(["last words"]);
    expect(clock.pending()).toBe(0);
    batcher.drain();
    expect(flushed).toEqual(["last words"]);
  });

  it("clears its timer and drops pending output on dispose", () => {
    const { batcher, flushed, clock } = setup();
    batcher.push("unsent");
    batcher.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(1000);
    batcher.push("after");
    batcher.drain();
    expect(flushed).toEqual([]);
  });

  it("defaults to the shared batch limits", () => {
    const { batcher, flushed, clock } = setup();
    batcher.push("x".repeat(TERMINAL_BATCH_CHARS + 1));
    expect(flushed.map((batch) => batch.length)).toEqual([TERMINAL_BATCH_CHARS]);
    clock.advance(TERMINAL_BATCH_MS - 1);
    expect(flushed).toHaveLength(1);
    clock.advance(1);
    expect(flushed.map((batch) => batch.length)).toEqual([TERMINAL_BATCH_CHARS, 1]);
  });
});
