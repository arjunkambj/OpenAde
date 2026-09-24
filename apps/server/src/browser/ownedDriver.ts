/**
 * The owned-chromium driver — the one mode with no desktop behind it (the web
 * renderer, or the server run on its own). agent-browser launches its own
 * headless Chrome; the driver connects the session's `stream` WebSocket for
 * live JPEG frames and forwards the human's gestures into it.
 *
 * The desktop never opens this driver: `BrowserService` picks it only when the
 * server was started without a browser bridge handoff at all.
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BrowserHumanInput } from "@poseidon/contracts/rpc";

import type {
  AgentBrowserError,
  AgentBrowserSession,
  AgentBrowserUnavailable,
} from "./agentBrowser";
import { locationOf, type BrowserDriver, type DriverEvents } from "./driver";
import { connectStream, type StreamClient, type StreamClientError } from "./streamClient";

export const openOwnedDriver = (
  session: AgentBrowserSession,
  events: DriverEvents,
): Effect.Effect<
  BrowserDriver,
  AgentBrowserError | AgentBrowserUnavailable | StreamClientError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    // Opens about:blank, which also brings up the daemon and its stream server.
    yield* session.exec(["open"]);
    const status = yield* session.exec(["stream", "status"]);
    const port = status.port;
    let stream: StreamClient | null = null;
    if (typeof port === "number") {
      const client = yield* connectStream(`ws://127.0.0.1:${port}`).pipe(Effect.option);
      if (Option.isSome(client)) {
        stream = client.value;
        const consume = client.value.inbound.pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              if (message.type === "frame" && typeof message.data === "string") {
                const metadata = (message.metadata ?? {}) as Record<string, unknown>;
                yield* events.onFrame({
                  mediaType: "image/jpeg",
                  base64: message.data,
                  width: typeof metadata.deviceWidth === "number" ? metadata.deviceWidth : 0,
                  height: typeof metadata.deviceHeight === "number" ? metadata.deviceHeight : 0,
                  capturedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                });
              } else if (message.type === "url" && typeof message.url === "string") {
                yield* events.onUrl(message.url);
              }
            }),
          ),
          Effect.andThen(events.onEnded()),
          Effect.catch(() => events.onEnded()),
        );
        yield* Effect.forkIn(consume, scope);
      }
    }

    const sendInput = (input: BrowserHumanInput): Effect.Effect<void, StreamClientError> => {
      if (stream === null) return Effect.void;
      const client = stream;
      const sendAll = (messages: ReadonlyArray<Record<string, unknown>>) =>
        Effect.forEach(messages, (message) => client.send(message), { discard: true });
      switch (input.kind) {
        case "click":
          return sendAll([
            {
              type: "input_mouse",
              eventType: "mousePressed",
              x: input.x,
              y: input.y,
              button: input.button ?? "left",
              clickCount: 1,
            },
            {
              type: "input_mouse",
              eventType: "mouseReleased",
              x: input.x,
              y: input.y,
              button: input.button ?? "left",
              clickCount: 1,
            },
          ]);
        case "key":
          return sendAll([
            {
              type: "input_keyboard",
              eventType: "keyDown",
              key: input.key,
              code: input.key,
              ...(input.key.length === 1 ? { text: input.key } : {}),
              ...(input.modifiers !== undefined ? { modifiers: [...input.modifiers] } : {}),
            },
            {
              type: "input_keyboard",
              eventType: "keyUp",
              key: input.key,
              code: input.key,
            },
          ]);
        case "text":
          return sendAll([{ type: "input_keyboard", eventType: "char", text: input.text }]);
        case "scroll":
          return sendAll([
            {
              type: "input_mouse",
              eventType: "mouseWheel",
              x: 0,
              y: 0,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            },
          ]);
        default:
          // navigate / history / location are routed through exec by the service.
          return Effect.void;
      }
    };

    return {
      mode: "owned-chromium",
      exec: (argv, execOptions) => session.exec(argv, execOptions),
      sendInput,
      location: locationOf(session.exec),
      close: session.shutdown,
    };
  });
