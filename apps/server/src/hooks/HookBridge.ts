/**
 * The hook bridge: Command Code's PreToolUse POSTs land here.
 *
 * The generated `cmd-hook.mjs` posts the harness's hook payload to
 * `POST /hooks/pretooluse` with a bearer token this bridge issues per thread —
 * the token is the routing key and the capability in one: it lives only in the
 * spawned process's environment, and revoking it is `unregister`.
 *
 * The registered handler is the connector session's own approval flow: it runs
 * the permission ladder, opens `request.opened` cards for `prompt`, and parks
 * until the user answers — this route blocks on it up to the 590s ceiling
 * (under the harness's 600s hook cap and the script's 570s fetch timeout), then
 * denies. Requests are capped at 1MB.
 *
 * Journaling happens through the event log rather than a side channel: a
 * `prompt` decision emits `request.opened`/`request.resolved`, which the
 * ingestion reactor persists as `thread.approval.*` — so every answered hook
 * is already an orchestration event.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import type { ConnectorEndpoint } from "@poseidon/connector-sdk/definition";
import { uuidV7 } from "@poseidon/shared/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { isLoopbackOrigin } from "../rpc/origin";

const HOOK_ROUTE_PATH = "/hooks/pretooluse";
const HOOK_TIMEOUT_SECONDS = 590;
const HOOK_MAX_BODY_BYTES = 1024 * 1024;

/** What a session registers: hook payload in, hook response out. */
export type HookHandler = (body: unknown) => Effect.Effect<unknown>;

interface HookEntry {
  readonly threadId: ThreadId;
  readonly token: string;
  handler: HookHandler | null;
}

const DENY_TIMEOUT = {
  hookSpecificOutput: {
    permissionDecision: "deny",
    permissionDecisionReason: "approval timed out",
  },
};

const DENY_ERROR = {
  hookSpecificOutput: {
    permissionDecision: "deny",
    permissionDecisionReason: "hook bridge error",
  },
};

const DENY_NO_HANDLER = {
  hookSpecificOutput: {
    permissionDecision: "deny",
    permissionDecisionReason: "no approval handler is registered for this thread",
  },
};

export class HookBridge extends Context.Service<
  HookBridge,
  {
    /** The endpoint (and bearer) a thread's spawned processes should post to. */
    readonly endpointFor: (threadId: ThreadId) => Effect.Effect<ConnectorEndpoint>;
    readonly register: (threadId: ThreadId, handler: HookHandler) => Effect.Effect<void>;
    readonly unregister: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Answers one authenticated post — the route's half. `null` means the
     * bearer was not recognised (the route turns that into a 401); a failing
     * or over-long handler is answered `deny`, never an error a tool could
     * read as approval.
     */
    readonly answer: (token: string, body: unknown) => Effect.Effect<unknown | null>;
  }
>()("server/hooks/HookBridge") {
  static readonly layer = Layer.effect(
    HookBridge,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const entries = yield* Ref.make(new Map<string, HookEntry>()); // token → entry
      const tokens = yield* Ref.make(new Map<ThreadId, string>()); // threadId → token

      const tokenFor = (threadId: ThreadId): Effect.Effect<string> =>
        Ref.modify(tokens, (byThread): readonly [string, Map<ThreadId, string>] => {
          const existing = byThread.get(threadId);
          if (existing !== undefined) {
            return [existing, byThread];
          }
          const token = uuidV7();
          const next = new Map(byThread);
          next.set(threadId, token);
          return [token, next];
        }).pipe(
          Effect.tap((token) =>
            Ref.update(entries, (byToken) => {
              if (byToken.has(token)) {
                return byToken;
              }
              const next = new Map(byToken);
              next.set(token, { threadId, token, handler: null });
              return next;
            }),
          ),
        );

      const port = (): number => {
        const address = server.address;
        return address._tag === "TcpAddress" ? address.port : 0;
      };

      return HookBridge.of({
        endpointFor: (threadId) =>
          tokenFor(threadId).pipe(
            Effect.map((token) => ({
              url: `http://127.0.0.1:${port()}${HOOK_ROUTE_PATH}`,
              bearer: token,
            })),
          ),
        register: (threadId, handler) =>
          Effect.gen(function* () {
            const token = yield* tokenFor(threadId);
            yield* Ref.update(entries, (byToken) => {
              const next = new Map(byToken);
              next.set(token, { threadId, token, handler });
              return next;
            });
          }),
        unregister: (threadId) =>
          Effect.gen(function* () {
            const token = yield* Ref.modify(tokens, (byThread) => {
              const token = byThread.get(threadId) ?? null;
              const next = new Map(byThread);
              next.delete(threadId);
              return [token, next] as const;
            });
            if (token !== null) {
              yield* Ref.update(entries, (byToken) => {
                const next = new Map(byToken);
                next.delete(token);
                return next;
              });
            }
          }),
        answer: (token, body) =>
          Ref.get(entries).pipe(
            Effect.flatMap((byToken) => {
              const entry = byToken.get(token);
              if (entry === undefined) {
                // Unknown bearer — the route turns null into a 401.
                return Effect.succeed(null);
              }
              if (entry.handler === null) {
                return Effect.succeed(DENY_NO_HANDLER);
              }
              const handler = entry.handler;
              // Effect.exit, not Effect.catch: a handler that throws defects
              // must still read as deny, never as an error a tool could take
              // for approval.
              return Effect.exit(
                Effect.raceFirst(
                  handler(body),
                  Effect.sleep(`${HOOK_TIMEOUT_SECONDS} seconds`).pipe(Effect.as(DENY_TIMEOUT)),
                ),
              ).pipe(
                Effect.tap((outcome) =>
                  Effect.logDebug("hook decision", {
                    threadId: entry.threadId,
                    outcome: Exit.isSuccess(outcome) ? "answered" : "denied",
                  }),
                ),
                Effect.map((outcome) => (Exit.isSuccess(outcome) ? outcome.value : DENY_ERROR)),
              );
            }),
          ),
      });
    }),
  );

  /**
   * Mounts `POST /hooks/pretooluse` on the ambient router. The bridge is
   * captured when the layer builds — not per request — so the requirement is
   * an ordinary layer input: merge `HookBridge.route` and `HookBridge.layer`
   * into the route composition the way `routesLayer` merges `/ws`, and the
   * built bridge stays reachable for the server's `ConnectorServices`.
   */
  static readonly route = Layer.unwrap(
    Effect.gen(function* () {
      const bridge = yield* HookBridge;
      return HttpRouter.add(
        "POST",
        HOOK_ROUTE_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          // The hook script is a child process of ours and sends no `Origin`;
          // anything that does is a page that found the port, and the ticket is
          // not the only thing that should stand between it and an approval.
          if (!isLoopbackOrigin(request.headers["origin"])) {
            return HttpServerResponse.text("forbidden origin", { status: 403 });
          }
          const authorization = request.headers["authorization"] ?? "";
          const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
          if (token === null) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          const declared = Number.parseInt(request.headers["content-length"] ?? "0", 10);
          if (declared > HOOK_MAX_BODY_BYTES) {
            return HttpServerResponse.text("body too large", { status: 413 });
          }
          const text = yield* request.text.pipe(Effect.catch(() => Effect.succeed(null)));
          if (text === null || text.length > HOOK_MAX_BODY_BYTES) {
            return text === null
              ? HttpServerResponse.text("unreadable body", { status: 400 })
              : HttpServerResponse.text("body too large", { status: 413 });
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return HttpServerResponse.text("invalid JSON", { status: 400 });
          }
          const answer = yield* bridge.answer(token, body);
          if (answer === null) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          return yield* HttpServerResponse.json(answer);
        }),
      );
    }),
  );
}
