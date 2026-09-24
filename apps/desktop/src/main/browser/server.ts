/**
 * The browser bridge's socket: one loopback HTTP server for every thread.
 *
 * It has no HTTP surface at all — every plain request is a 404 — and a
 * WebSocket upgrade is handed to `ws` only after `upgradeGate.ts` accepts it,
 * so a refused handshake never reaches a WebSocket parser. Each accepted
 * connection gets its own `bridgeSession.ts` router over the injected
 * `GuestPort`; the native-input queue is shared by all of them, because focus
 * belongs to the window.
 *
 * Electron-free: the shell passes in the port, the launch key and the version
 * it reports, and the tests run the real server against a fake port.
 */

import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { verifyCapability } from "@OpenAde/shared/browserBridge";

import {
  makeSerialQueue,
  openBridgeSession,
  type BridgeSessionOptions,
  type BrowserVersion,
  type GuestPort,
} from "./bridgeSession";
import { decideUpgrade } from "./upgradeGate";

/** Client commands are small; a screenshot only ever travels the other way. */
const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface BridgeServerOptions {
  readonly launchKey: string;
  readonly port: GuestPort;
  readonly version: BrowserVersion;
  /** One line per refused handshake and per connection, for the shell's log. */
  readonly log?: (entry: Readonly<Record<string, unknown>>) => void;
  /** Every message on every connection, for recordings. */
  readonly onFrame?: (
    frame: Readonly<{
      threadId: string;
      connection: number;
      direction: Parameters<NonNullable<BridgeSessionOptions["onFrame"]>>[0];
      message: Readonly<Record<string, unknown>>;
    }>,
  ) => void;
}

export interface BridgeServer {
  /** `ws://127.0.0.1:<port>` — what the server is told, never a thread URL. */
  readonly origin: string;
  readonly listenPort: number;
  /** Drops every connection of a thread (the thread closed or was deleted). */
  readonly disconnect: (threadId: string) => void;
  readonly close: () => Promise<void>;
}

const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export const startBridgeServer = async (options: BridgeServerOptions): Promise<BridgeServer> => {
  const log = options.log ?? (() => undefined);
  const inputQueue = makeSerialQueue();
  const connections = new Map<WebSocket, string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  let nextConnection = 0;

  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(404, { "content-length": "0", connection: "close" }).end();
  });

  const accept = (socket: WebSocket, threadId: string): void => {
    const connection = ++nextConnection;
    connections.set(socket, threadId);
    log({ event: "connected", threadId, connection });
    const session = openBridgeSession({
      threadId,
      port: options.port,
      version: options.version,
      inputQueue,
      emit: (message) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      ...(options.onFrame === undefined
        ? {}
        : {
            onFrame: (direction, message) =>
              options.onFrame?.({ threadId, connection, direction, message }),
          }),
    });
    socket.on("message", (data, isBinary) => {
      let message: unknown;
      try {
        message = isBinary ? undefined : JSON.parse(String(data));
      } catch {
        message = undefined;
      }
      if (typeof message !== "object" || message === null) {
        socket.close(1003, "not a CDP message");
        return;
      }
      void session.receive(message);
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      connections.delete(socket);
      log({ event: "disconnected", threadId, connection });
      void session.close();
    });
  };

  server.on("upgrade", (request: NodeHttp.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const decision = decideUpgrade(request, listenPort, (threadId, capability) =>
      verifyCapability(options.launchKey, threadId, capability),
    );
    if (!decision.accept) {
      log({ event: "refused", reason: decision.reason });
      socket.end(NOT_FOUND);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, decision.threadId));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const listenPort = (server.address() as AddressInfo).port;

  return {
    origin: `ws://127.0.0.1:${listenPort}`,
    listenPort,
    disconnect: (threadId) => {
      for (const [socket, owner] of connections) {
        if (owner === threadId) {
          socket.close(1001, "thread closed");
        }
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections.keys()) {
          socket.terminate();
        }
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
