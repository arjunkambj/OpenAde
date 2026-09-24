/**
 * The capability that admits a CDP client to one thread's in-app browser.
 *
 * The desktop shell runs a loopback bridge that speaks the Chrome DevTools
 * Protocol for the browser pane's webviews and nothing else. A client reaches
 * it at `ws://127.0.0.1:<port>/cdp/<threadId>/<capability>`, where the
 * capability is `HMAC-SHA256(launchKey, threadId)`: the shell mints the launch
 * key once per launch and hands it to the server, the server mints the URL
 * for the thread whose agent is browsing, and the shell verifies it on the
 * upgrade. Neither side stores a table of tokens, and a URL for one thread
 * says nothing about another's.
 *
 * It lives here because both sides compute it: `apps/desktop` verifies and
 * `apps/server` mints, and `shared` is the one package both may import.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** What a thread id in a bridge path may look like; anything else is refused. */
export const BRIDGE_THREAD_ID = /^[A-Za-z0-9_-]+$/;

/** A fresh launch key: 32 random bytes, hex. One per shell launch. */
export const mintLaunchKey = (): string => randomBytes(32).toString("hex");

/** The thread's capability under `launchKey`: HMAC-SHA256, hex. */
export const bridgeCapability = (launchKey: string, threadId: string): string =>
  createHmac("sha256", launchKey).update(threadId).digest("hex");

/**
 * The WebSocket URL agent-browser dials for `threadId`.
 *
 * `base` is the bridge's origin as the shell announced it (`ws://` or
 * `http://`, either works); the result is always the `ws://` form, because
 * agent-browser drops the path of an `http://` endpoint and probes `/json` at
 * the root, which the bridge refuses. Only a `127.0.0.1` origin is accepted.
 */
export const bridgeThreadUrl = (base: string, launchKey: string, threadId: string): string => {
  if (!BRIDGE_THREAD_ID.test(threadId)) {
    throw new Error(`not a bridge thread id: ${threadId}`);
  }
  const origin = new URL(base);
  if (origin.hostname !== "127.0.0.1" || origin.port === "") {
    throw new Error("the browser bridge must be a 127.0.0.1 origin with a port");
  }
  return `ws://127.0.0.1:${origin.port}/cdp/${threadId}/${bridgeCapability(launchKey, threadId)}`;
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Whether `supplied` is `threadId`'s capability under `launchKey`.
 *
 * Both sides are hashed to a fixed length before the constant-time compare,
 * so a short, long or wrong capability costs the same as a right one and the
 * compare itself never throws on a length mismatch.
 */
export const verifyCapability = (launchKey: string, threadId: string, supplied: string): boolean =>
  timingSafeEqual(digest(bridgeCapability(launchKey, threadId)), digest(supplied));
