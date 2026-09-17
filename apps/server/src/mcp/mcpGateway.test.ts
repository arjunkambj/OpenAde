/**
 * The MCP surface over a real loopback server:
 *
 * - `POST /mcp` without a bearer → 401; a minted bearer → JSON-RPC works.
 * - `initialize` / `tools/list` answer the protocol handshake.
 * - `tools/call browser_open` drives the fake driver through the session's
 *   serialized queue — the same path `mcp__openade__browser_open` takes.
 * - `revoke` kills the bearer — dead requests 401.
 */

import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { makeThreadId } from "@OpenAde/contracts/ids";
import { makeRegistry } from "@OpenAde/connector-sdk/registry";

import { makeFakeDriver, type BrowserDriver, type FakePage } from "../browser/driver";
import { makeService, type OpenDriverOptions } from "../browser/BrowserService";
import { OrchestrationEngine } from "../orchestration/Engine";
import { ConnectorSelection, SessionManager } from "../orchestration/SessionManager";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { mcpRoutesLayer } from "./httpRoute";
import { McpGateway } from "./McpGateway";

const threadId = makeThreadId();

const fakePage = (): FakePage => ({
  url: "about:blank",
  title: "Blank",
  lines: [{ role: "link", name: "Docs", ref: "e1", url: "https://example.com/docs" }],
  history: [],
  historyIndex: -1,
});

const permissionsStub = Layer.succeed(
  PermissionService,
  PermissionService.of({
    decide: () => Effect.succeed("allow" as const),
    rules: () => Effect.succeed([]),
    addRule: () => Effect.void,
  }),
);

const buildStack = (
  openDriver: (
    options: OpenDriverOptions,
  ) => Effect.Effect<BrowserDriver, { readonly message: string }, never>,
) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const registry = yield* makeRegistry([]);
    const selection = ConnectorSelection.fromRegistry(registry);
    const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));

    const http = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" });
    const httpContext = yield* Layer.build(http);
    const httpLayer = Layer.succeedContext(httpContext);

    const browser = Layer.effect(
      BrowserService,
      makeService({ cdpAvailable: false, openDriver }),
    ).pipe(Layer.provide(Layer.mergeAll(engine, permissionsStub, httpLayer)));

    const gateway = McpGateway.layer.pipe(
      Layer.provide(Layer.mergeAll(browser, engine, manager, httpLayer)),
    );

    const app = HttpRouter.serve(mcpRoutesLayer).pipe(
      Layer.provide(gateway),
      Layer.provide(httpLayer),
    );
    const context = yield* Layer.build(Layer.mergeAll(app, gateway));

    const server = Context.get(httpContext, HttpServer.HttpServer);
    const address = server.address;
    const port = typeof address === "object" && "port" in address ? address.port : 0;

    return { gateway: Context.get(context, McpGateway), port };
  });

interface JsonRpcResult {
  readonly status: number;
  readonly body: {
    readonly result?: {
      readonly tools?: ReadonlyArray<{ readonly name: string }>;
      readonly protocolVersion?: string;
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly structuredContent?: Record<string, unknown>;
      readonly isError?: boolean;
    };
    readonly error?: { readonly code: number; readonly message: string };
  } | null;
}

const post = async (
  url: string,
  bearer: string | null,
  message: unknown,
): Promise<JsonRpcResult> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as JsonRpcResult["body"]),
  };
};

describe("McpGateway", () => {
  it.live("bearer-gated JSON-RPC: initialize, tools/list, tools/call, revoke", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, port } = yield* buildStack(() =>
          Effect.succeed(makeFakeDriver(fakePage())),
        );
        const url = `http://127.0.0.1:${port}/mcp`;

        // No bearer → 401 before JSON-RPC is even parsed.
        const anonymous = yield* Effect.promise(() =>
          post(url, null, { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(anonymous.status).toBe(401);
        const wrong = yield* Effect.promise(() =>
          post(url, "not-a-token", { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(wrong.status).toBe(401);

        const endpoint = yield* gateway.endpoint(threadId);
        expect(endpoint.url).toBe(url);
        const bearer = endpoint.bearer;

        const init = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(init.body?.result?.protocolVersion).toBe("2025-06-18");

        const list = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
        );
        const names = (list.body?.result?.tools ?? []).map((tool) => tool.name);
        expect(names).toContain("browser_open");
        expect(names).toContain("browser_snapshot");
        expect(names).toContain("browser_eval");

        // tools/call goes through the fake driver's page.
        const open = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "browser_open", arguments: { url: "https://example.com" } },
          }),
        );
        expect(open.body?.result?.isError).toBe(false);
        expect(JSON.stringify(open.body?.result?.structuredContent ?? {})).toContain(
          "https://example.com",
        );

        const badTool = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "browser_nope", arguments: {} },
          }),
        );
        expect(badTool.body?.error?.code).toBe(-32602);

        // Revoked bearers die — dead requests never reach a session.
        yield* gateway.revoke(threadId);
        const dead = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 5, method: "ping" }),
        );
        expect(dead.status).toBe(401);
      }),
    ),
  );
});
