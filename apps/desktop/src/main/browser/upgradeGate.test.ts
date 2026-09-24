import { describe, expect, it } from "vitest";

import { bridgeCapability, mintLaunchKey, verifyCapability } from "@OpenAde/shared/browserBridge";

import { decideUpgrade, type UpgradeRequest } from "./upgradeGate";

const PORT = 43_117;
const KEY = mintLaunchKey();
const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CAP = bridgeCapability(KEY, THREAD);
const verify = (threadId: string, capability: string): boolean =>
  verifyCapability(KEY, threadId, capability);

/** The handshake agent-browser 0.38.1 sends: no Origin, a loopback Host. */
const upgrade = (url: string, headers: UpgradeRequest["headers"] = {}): UpgradeRequest => ({
  method: "GET",
  url,
  headers: {
    host: `127.0.0.1:${PORT}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "zZ8xm4Avi/TMgmmNkgeyQQ==",
    ...headers,
  },
});

const decide = (request: UpgradeRequest) => decideUpgrade(request, PORT, verify);

describe("decideUpgrade", () => {
  it("admits agent-browser's handshake with the thread's capability", () => {
    expect(decide(upgrade(`/cdp/${THREAD}/${CAP}`))).toEqual({ accept: true, threadId: THREAD });
    expect(decide(upgrade(`/cdp/${THREAD}/${CAP}`, { host: `localhost:${PORT}` }))).toEqual({
      accept: true,
      threadId: THREAD,
    });
  });

  // The negative matrix from the attach spike: every row is a bare 404.
  const refused: ReadonlyArray<readonly [string, UpgradeRequest]> = [
    ["a wrong capability", upgrade(`/cdp/${THREAD}/${"0".repeat(64)}`)],
    ["another thread's capability", upgrade(`/cdp/other-thread/${CAP}`)],
    ["a short capability", upgrade(`/cdp/${THREAD}/${CAP.slice(0, 32)}`)],
    ["an upper-case capability", upgrade(`/cdp/${THREAD}/${CAP.toUpperCase()}`)],
    [
      "the right capability from a web page",
      upgrade(`/cdp/${THREAD}/${CAP}`, { origin: "https://evil.example" }),
    ],
    [
      "the right capability with Origin: null",
      upgrade(`/cdp/${THREAD}/${CAP}`, { origin: "null" }),
    ],
    ["a DNS-rebinding Host", upgrade(`/cdp/${THREAD}/${CAP}`, { host: `evil.example:${PORT}` })],
    ["another port in Host", upgrade(`/cdp/${THREAD}/${CAP}`, { host: `127.0.0.1:${PORT + 1}` })],
    ["no Host", upgrade(`/cdp/${THREAD}/${CAP}`, { host: undefined })],
    ["no path", upgrade("/")],
    ["the thread with no capability", upgrade(`/cdp/${THREAD}`)],
    ["a trailing path", upgrade(`/cdp/${THREAD}/${CAP}/json/version`)],
    ["a query string", upgrade(`/cdp/${THREAD}/${CAP}?x=1`)],
    ["a traversal thread id", upgrade(`/cdp/..%2Fx/${CAP}`)],
    ["tokenless /json/version", upgrade("/json/version")],
    ["tokenless /json/list", upgrade("/json/list")],
    ["Chromium's own browser path", upgrade("/devtools/browser/4c935217-d782-423a")],
    [
      "a plain GET /json/version",
      { method: "GET", url: "/json/version", headers: { host: `127.0.0.1:${PORT}` } },
    ],
    [
      "a plain GET with the right capability",
      { method: "GET", url: `/cdp/${THREAD}/${CAP}`, headers: { host: `127.0.0.1:${PORT}` } },
    ],
    ["a POST upgrade", { ...upgrade(`/cdp/${THREAD}/${CAP}`), method: "POST" }],
    ["an upgrade to something else", upgrade(`/cdp/${THREAD}/${CAP}`, { upgrade: "h2c" })],
  ];

  it.each(refused)("refuses %s with a 404", (_name, request) => {
    const decision = decide(request);
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.status).toBe(404);
      expect(decision.reason).not.toContain(CAP);
    }
  });

  it("asks verify only once everything else has passed", () => {
    const asked: Array<string> = [];
    const spy = (threadId: string, capability: string): boolean => {
      asked.push(threadId);
      return verify(threadId, capability);
    };
    decideUpgrade(upgrade(`/cdp/${THREAD}/${CAP}`, { origin: "https://x" }), PORT, spy);
    decideUpgrade(upgrade("/json/version"), PORT, spy);
    expect(asked).toEqual([]);
    decideUpgrade(upgrade(`/cdp/${THREAD}/${CAP}`), PORT, spy);
    expect(asked).toEqual([THREAD]);
  });
});
