/**
 * Client for agent-browser's per-session stream WebSocket (mode B).
 *
 * `stream status` reports the auto-bound port; the socket emits `status`,
 * `tabs`, `frame` (base64 JPEG) and `url` messages, and accepts
 * `input_mouse` / `input_keyboard` / `config` messages back. The inbound side
 * is an unbounded queue exposed as a `Stream` so the driver consumes it in
 * order; the socket is closed with the scope.
 */

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class StreamClientError extends Data.TaggedError("StreamClientError")<{
  readonly message: string;
}> {}

export type StreamMessage = Record<string, unknown> & { readonly type?: string };

export interface StreamClient {
  readonly inbound: Stream.Stream<StreamMessage, StreamClientError>;
  readonly send: (message: Record<string, unknown>) => Effect.Effect<void, StreamClientError>;
}

export const connectStream = (
  url: string,
): Effect.Effect<StreamClient, StreamClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<StreamMessage, Cause.Done<void>>();
    const scope = yield* Effect.scope;

    const ws = yield* Effect.callback<WebSocket, StreamClientError>((resume) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
      socket.addEventListener(
        "error",
        () =>
          resume(
            Effect.fail(new StreamClientError({ message: `stream socket failed for ${url}` })),
          ),
        { once: true },
      );
      return Effect.sync(() => socket.close());
    });

    ws.addEventListener("message", (event) => {
      try {
        const text = typeof event.data === "string" ? event.data : "";
        Queue.offerUnsafe(queue, JSON.parse(text) as StreamMessage);
      } catch {
        // A non-JSON frame is dropped; the protocol only speaks JSON.
      }
    });
    // A close or error ends the inbound stream; the driver maps that into the
    // session state rather than leaking a dead socket.
    ws.addEventListener("close", () => Queue.endUnsafe(queue));
    ws.addEventListener("error", () => Queue.endUnsafe(queue));

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        Queue.endUnsafe(queue);
        ws.close();
      }),
    );

    return {
      inbound: Stream.fromQueue(queue),
      send: (message) =>
        Effect.try({
          try: () => ws.send(JSON.stringify(message)),
          catch: () => new StreamClientError({ message: "stream send failed" }),
        }),
    };
  });
