import { describe, expect, it } from "vitest";

import {
  bridgeCapability,
  bridgeThreadUrl,
  mintLaunchKey,
  verifyCapability,
} from "./browserBridge";

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** Splits a minted URL the way the desktop's upgrade gate reads it. */
const capabilityOf = (url: string): { threadId: string; capability: string } => {
  const [, , threadId = "", capability = ""] = new URL(url).pathname.split("/");
  return { threadId, capability };
};

describe("mintLaunchKey", () => {
  it("is 32 random bytes of hex, fresh each launch", () => {
    const key = mintLaunchKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mintLaunchKey()).not.toBe(key);
  });
});

describe("bridgeThreadUrl", () => {
  it("gives the server a URL the desktop verifies for that thread only", () => {
    const key = mintLaunchKey();
    // The server mints from the announced base; the desktop verifies the path.
    const url = bridgeThreadUrl("ws://127.0.0.1:41234", key, THREAD);
    expect(url).toBe(`ws://127.0.0.1:41234/cdp/${THREAD}/${bridgeCapability(key, THREAD)}`);
    const { threadId, capability } = capabilityOf(url);
    expect(threadId).toBe(THREAD);
    expect(verifyCapability(key, threadId, capability)).toBe(true);
    expect(verifyCapability(key, "another-thread", capability)).toBe(false);
    expect(verifyCapability(mintLaunchKey(), threadId, capability)).toBe(false);
  });

  it("always hands out the ws:// form, even from an http:// base", () => {
    const key = mintLaunchKey();
    expect(bridgeThreadUrl("http://127.0.0.1:5000/", key, THREAD)).toBe(
      bridgeThreadUrl("ws://127.0.0.1:5000", key, THREAD),
    );
  });

  it("refuses a non-loopback origin and a thread id that is not path-safe", () => {
    const key = mintLaunchKey();
    expect(() => bridgeThreadUrl("ws://localhost:5000", key, THREAD)).toThrow();
    expect(() => bridgeThreadUrl("ws://10.0.0.2:5000", key, THREAD)).toThrow();
    expect(() => bridgeThreadUrl("ws://127.0.0.1", key, THREAD)).toThrow();
    expect(() => bridgeThreadUrl("ws://127.0.0.1:5000", key, "../x")).toThrow();
    expect(() => bridgeThreadUrl("ws://127.0.0.1:5000", key, "a/b")).toThrow();
  });
});

describe("verifyCapability", () => {
  it("refuses a wrong, short, long or empty capability without throwing", () => {
    const key = mintLaunchKey();
    const right = bridgeCapability(key, THREAD);
    const wrong = right.slice(0, -1) + (right.endsWith("0") ? "1" : "0");
    // Each of these reaches the constant-time compare: both sides are hashed
    // to 32 bytes first, so a length mismatch neither throws nor returns early.
    for (const supplied of [wrong, right.slice(0, 8), `${right}00`, "", "\u00e9".repeat(64)]) {
      expect(verifyCapability(key, THREAD, supplied)).toBe(false);
    }
    expect(verifyCapability(key, THREAD, right)).toBe(true);
    expect(verifyCapability(key, THREAD, right.toUpperCase())).toBe(false);
  });
});
