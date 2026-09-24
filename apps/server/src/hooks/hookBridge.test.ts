/**
 * The hook bridge over a real socket: a `cmd` child posts PreToolUse requests
 * to `/hooks/pretooluse` on the same HTTP server the app uses, so the test
 * binds a real port and sends real requests — no in-memory handler.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { makeThreadId } from "@poseidon/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type { ServeError } from "effect/unstable/http/HttpServerError";

import { HookBridge } from "./HookBridge";

/** Builds the bridge and its route on a real bound port; closed with the scope. */
const withBridge = <A, E, R>(
  use: (bridge: HookBridge["Service"]) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ServeError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const httpContext = yield* Layer.build(
        NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }),
      );
      const bridgeContext = yield* Layer.build(
        HookBridge.layer.pipe(Layer.provide(Layer.succeedContext(httpContext))),
      );
      yield* Layer.build(
        HttpRouter.serve(
          HookBridge.route.pipe(Layer.provide(Layer.succeedContext(bridgeContext))),
          { disableListenLog: true },
        ).pipe(Layer.provide(Layer.succeedContext(httpContext))),
      );
      return yield* use(Context.get(bridgeContext, HookBridge));
    }),
  );

const post = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Effect.Effect<Response, Error> =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    catch: (error) => error as Error,
  });

describe("HookBridge over a real port", () => {
  it.effect("authenticates the post, calls the handler, and returns its decision", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
        yield* bridge.register(threadId, (body) =>
          Ref.update(seen, (list) => [...list, body]).pipe(
            Effect.as({
              hookSpecificOutput: {
                permissionDecision: "allow",
                permissionDecisionReason: "test says yes",
              },
            }),
          ),
        );

        const endpoint = yield* bridge.endpointFor(threadId);
        expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/pretooluse$/);

        const payload = {
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "shell_command",
          tool_input: { command: "ls" },
        };
        const response = yield* post(endpoint.url, payload, {
          authorization: `Bearer ${endpoint.bearer}`,
        });
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          hookSpecificOutput: {
            permissionDecision: "allow",
            permissionDecisionReason: "test says yes",
          },
        });
        expect(yield* Ref.get(seen)).toEqual([payload]);

        yield* bridge.unregister(threadId);
      }),
    ),
  );

  it.effect("rejects wrong or missing bearer and never calls the handler", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
        yield* bridge.register(threadId, (body) =>
          Ref.update(seen, (list) => [...list, body]).pipe(Effect.as({})),
        );
        const endpoint = yield* bridge.endpointFor(threadId);
        const payload = { session_id: "s", tool_name: "x" };

        const noAuth = yield* post(endpoint.url, payload);
        expect(noAuth.status).toBe(401);
        const wrongAuth = yield* post(endpoint.url, payload, {
          authorization: "Bearer not-the-token",
        });
        expect(wrongAuth.status).toBe(401);
        expect(yield* Ref.get(seen)).toEqual([]);

        yield* bridge.unregister(threadId);
      }),
    ),
  );

  it.effect("refuses a post that carries a page's origin", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        // The hook script is a child of ours and sends no Origin at all. A
        // request that carries one is a page that found the port, and the
        // ticket should not be the only thing between it and an approval.
        const threadId = makeThreadId();
        const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
        yield* bridge.register(threadId, (body) =>
          Ref.update(seen, (list) => [...list, body]).pipe(Effect.as({})),
        );
        const endpoint = yield* bridge.endpointFor(threadId);
        const payload = { session_id: "s", tool_name: "x" };

        for (const origin of ["https://evil.example", "null"]) {
          const refused = yield* post(endpoint.url, payload, {
            authorization: `Bearer ${endpoint.bearer}`,
            origin,
          });
          expect(refused.status).toBe(403);
        }
        expect(yield* Ref.get(seen)).toEqual([]);

        yield* bridge.unregister(threadId);
      }),
    ),
  );

  it.effect("denies a post for a thread with no handler", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const endpoint = yield* bridge.endpointFor(makeThreadId());
        const response = yield* post(
          endpoint.url,
          { session_id: "s", tool_name: "shell_command" },
          { authorization: `Bearer ${endpoint.bearer}` },
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "no approval handler is registered for this thread",
          },
        });
      }),
    ),
  );

  it.effect("denies on handler failure and after unregister", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        yield* bridge.register(threadId, () => Effect.die(new Error("boom")));
        const endpoint = yield* bridge.endpointFor(threadId);
        const failed = yield* post(
          endpoint.url,
          { session_id: "s" },
          { authorization: `Bearer ${endpoint.bearer}` },
        );
        const failedBody = (yield* Effect.promise(() => failed.json())) as {
          hookSpecificOutput: { permissionDecision: string };
        };
        expect(failedBody.hookSpecificOutput.permissionDecision).toBe("deny");

        // Unregistering revokes the bearer outright: the post is a 401.
        yield* bridge.unregister(threadId);
        const after = yield* post(
          endpoint.url,
          { session_id: "s" },
          { authorization: `Bearer ${endpoint.bearer}` },
        );
        expect(after.status).toBe(401);
      }),
    ),
  );

  it.effect("rejects bodies over 1 MiB before parsing", () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        yield* bridge.register(threadId, () => Effect.succeed({}));
        const endpoint = yield* bridge.endpointFor(threadId);
        const huge = "x".repeat(1024 * 1024 + 1);
        const response = yield* post(endpoint.url, `"${huge}"`, {
          authorization: `Bearer ${endpoint.bearer}`,
        });
        expect(response.status).toBe(413);
        yield* bridge.unregister(threadId);
      }),
    ),
  );
});
