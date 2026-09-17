/**
 * The loopback MCP HTTP surface:
 *
 * - `POST /mcp` — the per-session JSON-RPC endpoint the harness calls
 *   (`mcp__openade__browser_*`). Bearer auth resolves to a thread, the body is
 *   bounded, notifications answer 202.
 * - `GET /browser/attach/:threadId` — the marker page the desktop pane loads
 *   into its webview. Its URL is how the CDP driver identifies the guest
 *   target, so it stays unauthenticated (the webview cannot send headers) and
 *   completely inert.
 * - `POST /hooks/pretooluse` — the endpoint `services.hookEndpoint` already
 *   hands out; it answers 501 until W2's hook bridge lands.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MaxBodySize } from "effect/unstable/http/HttpIncomingMessage";

import { McpGateway, type JsonRpcRequest } from "./McpGateway";

const BODY_CAP = FileSystem.Size(1024 * 1024);

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });

const bearerOf = (request: HttpServerRequest.HttpServerRequest): string | null => {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : null;
};

const mcpRoute = Effect.gen(function* () {
  const gateway = yield* McpGateway;
  const request = yield* HttpServerRequest.HttpServerRequest;

  const token = bearerOf(request);
  const threadId = token === null ? Option.none() : yield* gateway.resolve(token);
  if (Option.isNone(threadId)) return unauthorized();

  const text = yield* request.text.pipe(
    Effect.provideService(MaxBodySize, BODY_CAP),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (text === null) {
    return HttpServerResponse.jsonUnsafe({ error: "body too large" }, { status: 413 });
  }
  const parsed = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.option);
  if (Option.isNone(parsed)) {
    return HttpServerResponse.jsonUnsafe(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400 },
    );
  }
  const body = parsed.value;

  if (Array.isArray(body)) {
    const responses = yield* Effect.forEach(body, (message) =>
      gateway.handleMessage(threadId.value, message as JsonRpcRequest),
    );
    const filtered = responses.filter((response) => response !== null);
    return filtered.length === 0
      ? HttpServerResponse.empty({ status: 202 })
      : HttpServerResponse.jsonUnsafe(filtered);
  }

  const response = yield* gateway.handleMessage(threadId.value, body as JsonRpcRequest);
  return response === null
    ? HttpServerResponse.empty({ status: 202 })
    : HttpServerResponse.jsonUnsafe(response);
});

const attachPageRoute = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const threadId = params.threadId ?? "";
  return HttpServerResponse.text(attachPage(threadId), {
    contentType: "text/html; charset=utf-8",
  });
});

const attachPage = (threadId: string): string => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>openade · ${escapeHtml(threadId)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #14151a; color: #8b8e98;
    font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  .box { text-align: center; }
  .mark { width: 22px; height: 22px; border-radius: 6px; margin: 0 auto 10px;
    background: linear-gradient(135deg, #6d8dff, #9a6dff); opacity: .8; }
</style>
</head>
<body>
  <div class="box">
    <div class="mark"></div>
    <div>OpenAde browser</div>
    <div>waiting for a page…</div>
  </div>
</body>
</html>`;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hooksStub = HttpServerResponse.jsonUnsafe(
  { error: "hook bridge not implemented (W2)" },
  { status: 501 },
);

/** The extra HTTP routes W6 adds to the server's router. */
export const mcpRoutesLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/mcp", mcpRoute),
  HttpRouter.add("GET", "/browser/attach/:threadId", attachPageRoute),
  HttpRouter.add("POST", "/hooks/pretooluse", hooksStub),
);
