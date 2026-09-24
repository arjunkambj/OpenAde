import { describe, expect, it } from "vitest";

import { RETURN_DEDUPE_MS, subscribeWindowReturn, type ReturnSources } from "./window-return";

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
