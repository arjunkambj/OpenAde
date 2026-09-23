import { describe, expect, it } from "vitest";

import { makeInputQueue } from "./inputQueue";

const reader = <A>(iterable: AsyncIterable<A>) => iterable[Symbol.asyncIterator]();

describe("makeInputQueue", () => {
  it("delivers what was pushed before the reader asked", async () => {
    const queue = makeInputQueue<string>();
    queue.push("a");
    queue.push("b");
    const next = reader(queue.iterable);
    expect(await next.next()).toEqual({ done: false, value: "a" });
    expect(await next.next()).toEqual({ done: false, value: "b" });
  });

  it("wakes a reader parked on an empty queue", async () => {
    const queue = makeInputQueue<string>();
    const pending = reader(queue.iterable).next();
    queue.push("steer");
    expect(await pending).toEqual({ done: false, value: "steer" });
  });

  it("finishes after the buffered messages once ended", async () => {
    const queue = makeInputQueue<string>();
    const next = reader(queue.iterable);
    queue.push("last");
    queue.end();
    expect(await next.next()).toEqual({ done: false, value: "last" });
    expect((await next.next()).done).toBe(true);
    expect(queue.ended()).toBe(true);
  });

  it("releases a parked reader when it ends", async () => {
    const queue = makeInputQueue<string>();
    const pending = reader(queue.iterable).next();
    queue.end();
    expect((await pending).done).toBe(true);
  });

  it("refuses a push after the end", () => {
    const queue = makeInputQueue<string>();
    queue.end();
    expect(queue.push("late")).toBe(false);
  });

  it("stops at once when the reader returns", async () => {
    const queue = makeInputQueue<string>();
    queue.push("unread");
    const next = reader(queue.iterable);
    await next.return?.();
    expect((await next.next()).done).toBe(true);
    expect(queue.push("after")).toBe(false);
  });
});
