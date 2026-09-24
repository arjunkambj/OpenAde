import * as NodeHttp from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { bridgeThreadUrl, mintLaunchKey } from "@poseidon/shared/browserBridge";

import { startBridgeServer, type BridgeServer } from "./server";
import { FakeGuestPort, VERSION } from "./test/replay";

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let key: string;
let port: FakeGuestPort;
let server: BridgeServer;
let refused: Array<string>;

beforeEach(async () => {
  key = mintLaunchKey();
  port = new FakeGuestPort();
  port.addGuest(THREAD, "OWN-TARGET", "https://example.com/");
  refused = [];
  server = await startBridgeServer({
    launchKey: key,
    port,
    version: VERSION,
    log: (entry) => {
      if (entry["event"] === "refused") refused.push(String(entry["reason"]));
    },
  });
});

afterEach(async () => {
  await server.close();
});

/** Opens a client and resolves once it is open, or with the refusal's status. */
const dial = (
  url: string,
  headers: Record<string, string> = {},
): Promise<{ socket: WebSocket } | { status: number }> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve({ socket }));
    socket.once("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once("error", reject);
  });

/** Sends one command and resolves with the reply that carries its id. */
const call = (socket: WebSocket, message: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (data: unknown) => {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      if (parsed["id"] === message["id"]) {
        socket.off("message", onMessage);
        resolve(parsed);
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify(message));
  });

const closed = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

describe("startBridgeServer", () => {
  it("listens on 127.0.0.1 only and announces the ws:// origin", () => {
    expect(server.origin).toBe(`ws://127.0.0.1:${server.listenPort}`);
  });

  it("upgrades the thread's capability URL and routes CDP over it", async () => {
    const dialed = await dial(bridgeThreadUrl(server.origin, key, THREAD));
    if (!("socket" in dialed)) throw new Error(`refused with ${dialed.status}`);
    const { socket } = dialed;
    expect(await call(socket, { id: 1, method: "Browser.getVersion" })).toEqual({
      id: 1,
      result: VERSION,
    });
    const targets = await call(socket, { id: 2, method: "Target.getTargets" });
    expect(targets["result"]).toMatchObject({
      targetInfos: [{ targetId: "OWN-TARGET", type: "page" }],
    });
    const attached = await call(socket, {
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    expect(attached["result"]).toEqual({ sessionId: "SESSION-1" });
    // Hanging up detaches what the client opened.
    const gone = closed(socket);
    socket.close();
    await gone;
    await expect
      .poll(() => port.calls.filter((entry) => entry.op === "detachChild"))
      .toEqual([{ op: "detachChild", wcId: 1, sessionId: "SESSION-1" }]);
  });

  it("answers 404 to a wrong capability, another thread's, a web Origin and discovery", async () => {
    const right = bridgeThreadUrl(server.origin, key, THREAD);
    const cases: ReadonlyArray<readonly [string, Record<string, string>]> = [
      [bridgeThreadUrl(server.origin, mintLaunchKey(), THREAD), {}],
      [right.replace(THREAD, "other-thread"), {}],
      [right, { Origin: "https://evil.example" }],
      [`${server.origin}/json/version`, {}],
      [`${server.origin}/devtools/browser/x`, {}],
      [`${server.origin}/`, {}],
    ];
    for (const [url, headers] of cases) {
      expect(await dial(url, headers)).toEqual({ status: 404 });
    }
    expect(refused).toHaveLength(cases.length);
    for (const reason of refused) {
      expect(reason).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it("has no plain HTTP surface at all", async () => {
    for (const path of ["/json/version", "/json/list", "/", `/cdp/${THREAD}/${"0".repeat(64)}`]) {
      const status = await new Promise<number>((resolve, reject) => {
        NodeHttp.get(`http://127.0.0.1:${server.listenPort}${path}`, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).once("error", reject);
      });
      expect(status).toBe(404);
    }
  });

  it("drops a thread's connections when the thread goes away", async () => {
    const dialed = await dial(bridgeThreadUrl(server.origin, key, THREAD));
    if (!("socket" in dialed)) throw new Error(`refused with ${dialed.status}`);
    const gone = closed(dialed.socket);
    server.disconnect(THREAD);
    expect(await gone).toBe(1001);
  });

  it("closes a connection that sends something that is not a CDP message", async () => {
    const dialed = await dial(bridgeThreadUrl(server.origin, key, THREAD));
    if (!("socket" in dialed)) throw new Error(`refused with ${dialed.status}`);
    const gone = closed(dialed.socket);
    dialed.socket.send("not json");
    expect(await gone).toBe(1003);
  });
});
