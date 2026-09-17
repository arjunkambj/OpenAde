/**
 * The WebSocket transport. One GET /ws route: the upgrade carries the boot
 * token as a query param, anything else gets a 401 before the RPC protocol
 * ever runs. Everything else is `RpcServer` over `layerJson`.
 */

import { OpenAdeRpcGroup } from "@OpenAde/contracts/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { HookBridge } from "../hooks/HookBridge";
import { handlersLayer } from "./handlers";

/** The token every /ws upgrade must present, generated at boot. */
export class ServerToken extends Context.Service<
  ServerToken,
  {
    readonly token: string;
  }
>()("server/rpc/ServerToken") {}

const wsRoute = Effect.gen(function* () {
  const { token } = yield* ServerToken;
  const serialization = yield* Layer.build(RpcSerialization.layerJson);
  const handlers = yield* Layer.build(handlersLayer);
  // The full per-connection effect: protocol + server + upgrade in one.
  const wsHandler = yield* RpcServer.toHttpEffectWebsocket(OpenAdeRpcGroup, {
    disableTracing: true,
  }).pipe(Effect.provide(handlers), Effect.provide(serialization));

  return HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      if (url.searchParams.get("token") !== token) {
        return HttpServerResponse.text("unauthorized", { status: 401 });
      }
      return yield* wsHandler;
    }),
  );
});

/**
 * All routes, built over the empty router. The hook bridge rides along: its
 * service lands in the merged output so `POST /hooks/pretooluse` handlers can
 * look it up per request, and its `HttpServer` requirement is the same one
 * `serve` already needs.
 */
export const routesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const ws = yield* wsRoute;
    return ws.pipe(
      Layer.provideMerge(HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"))),
      Layer.provideMerge(HookBridge.route),
      Layer.provideMerge(HookBridge.layer),
      Layer.provide(HttpRouter.layer),
    );
  }),
);

/**
 * Serves the routes on the ambient `HttpServer`. Provide a
 * `NodeHttpServer.layer(...)` (or the test layer) below it.
 */
export const serverLayer = HttpRouter.serve(routesLayer, {
  disableListenLog: true,
});
