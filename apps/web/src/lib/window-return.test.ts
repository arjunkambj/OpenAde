import { describe, expect, it } from "vitest";

import {
  RETURN_DEDUPE_MS,
  makeSharedWindowReturn,
  subscribeWindowReturn,
  type ReturnSources,
} from "./window-return";

/** A window and a document as plain event targets, with a clock the test moves. */
const sources = () => {
  const clock = { now: 0 };
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const window = new EventTarget();
  const fake: ReturnSources = { window, document, now: () => clock.now };
  return { fake, clock, window, document };
};

describe("subscribeWindowReturn", () => {
  it("fires when the window regains focus", () => {
    const { fake, window } = sources();
    let returns = 0;
    subscribeWindowReturn(() => returns++, fake);
    window.dispatchEvent(new Event("focus"));
    expect(returns).toBe(1);
  });

  it("fires when the page turns visible, not when it is hidden", () => {
    const { fake, clock, document } = sources();
    let returns = 0;
    subscribeWindowReturn(() => returns++, fake);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(returns).toBe(0);
    clock.now += RETURN_DEDUPE_MS;
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(returns).toBe(1);
  });

  it("counts focus and visibility fired together as one return", () => {
    const { fake, clock, window, document } = sources();
    let returns = 0;
    subscribeWindowReturn(() => returns++, fake);
    document.dispatchEvent(new Event("visibilitychange"));
    clock.now += 10;
    window.dispatchEvent(new Event("focus"));
    expect(returns).toBe(1);
    clock.now += RETURN_DEDUPE_MS;
    window.dispatchEvent(new Event("focus"));
    expect(returns).toBe(2);
  });

  it("stops after the unsubscribe", () => {
    const { fake, window } = sources();
    let returns = 0;
    const unsubscribe = subscribeWindowReturn(() => returns++, fake);
    unsubscribe();
    window.dispatchEvent(new Event("focus"));
    expect(returns).toBe(0);
  });
});

describe("makeSharedWindowReturn", () => {
  it("calls one subscriber per key on each return, however many share it", () => {
    const { fake, window } = sources();
    const subscribe = makeSharedWindowReturn(fake);
    const calls: Array<string> = [];
    subscribe("project-a", () => calls.push("a1"));
    subscribe("project-a", () => calls.push("a2"));
    subscribe("project-b", () => calls.push("b1"));
    window.dispatchEvent(new Event("focus"));
    expect(calls).toEqual(["a1", "b1"]);
  });

  it("hands the key to the next subscriber when the first leaves, and stops after the last", () => {
    const { fake, clock, window } = sources();
    const subscribe = makeSharedWindowReturn(fake);
    const calls: Array<string> = [];
    const leaveFirst = subscribe("project-a", () => calls.push("first"));
    const leaveSecond = subscribe("project-a", () => calls.push("second"));
    leaveFirst();
    window.dispatchEvent(new Event("focus"));
    expect(calls).toEqual(["second"]);
    leaveSecond();
    clock.now += RETURN_DEDUPE_MS;
    window.dispatchEvent(new Event("focus"));
    expect(calls).toEqual(["second"]);
  });
});
