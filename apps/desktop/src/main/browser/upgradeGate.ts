/**
 * Who may open a WebSocket to the browser bridge.
 *
 * The bridge listens on `127.0.0.1` with an ephemeral port, so anything
 * running as this user can reach the socket; the capability in the path is
 * what scopes it. Everything else a local attacker could try is shut here,
 * before `ws` sees the request:
 *
 * - **A web page.** Browsers always send `Origin` on a WebSocket handshake and
 *   agent-browser never does, so any `Origin` at all — `null` included — is
 *   refused. A DNS-rebinding page shows up with a foreign `Host` instead, and
 *   only `127.0.0.1:<port>` or `localhost:<port>` pass.
 * - **Discovery.** There is no `/json/version`, `/json/list` or any other
 *   HTTP surface: plain requests, and upgrades on any path other than
 *   `/cdp/<threadId>/<capability>`, get the same bare 404, so a probe learns
 *   nothing about which threads exist.
 * - **A guessed thread.** The capability is verified by the injected
 *   `verify` (constant-time, `@poseidon/shared/browserBridge`).
 *
 * Pure: the server passes the request line and headers in and acts on the
 * decision, so the whole matrix is a unit test.
 */

import { BRIDGE_THREAD_ID } from "@poseidon/shared/browserBridge";

/** The parts of an HTTP request the gate reads. */
export interface UpgradeRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export type UpgradeDecision =
  | { readonly accept: true; readonly threadId: string }
  | {
      readonly accept: false;
      readonly status: 404;
      /** For the shell's log. Never contains the supplied capability. */
      readonly reason: string;
    };

const refuse = (reason: string): UpgradeDecision => ({ accept: false, status: 404, reason });

const header = (request: UpgradeRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : value?.[0];
};

/** `/cdp/<threadId>/<64 hex>` and nothing else — no query, no trailing slash. */
const BRIDGE_PATH = /^\/cdp\/([^/]+)\/([^/]+)$/;
const CAPABILITY = /^[0-9a-f]{64}$/;

const isUpgrade = (request: UpgradeRequest): boolean =>
  request.method === "GET" &&
  header(request, "upgrade")?.toLowerCase() === "websocket" &&
  (header(request, "connection") ?? "")
    .toLowerCase()
    .split(",")
    .some((token) => token.trim() === "upgrade");

/**
 * Whether `request` may become a bridge connection, and for which thread.
 * `verify(threadId, capability)` answers whether the capability is that
 * thread's; it is only called once everything else has passed.
 */
export const decideUpgrade = (
  request: UpgradeRequest,
  port: number,
  verify: (threadId: string, capability: string) => boolean,
): UpgradeDecision => {
  if (!isUpgrade(request)) {
    return refuse("not a websocket upgrade");
  }
  if (request.headers["origin"] !== undefined) {
    return refuse("an Origin header: a browser page, not agent-browser");
  }
  const host = header(request, "host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return refuse("a foreign Host header");
  }
  const match = BRIDGE_PATH.exec(request.url ?? "");
  if (match === null) {
    return refuse("not a bridge path");
  }
  const [, threadId = "", capability = ""] = match;
  if (!BRIDGE_THREAD_ID.test(threadId) || !CAPABILITY.test(capability)) {
    return refuse("a malformed bridge path");
  }
  if (!verify(threadId, capability)) {
    return refuse("a capability that is not this thread's");
  }
  return { accept: true, threadId };
};
