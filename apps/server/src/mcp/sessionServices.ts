/**
 * The `ConnectorServices` bundle the server hands `registry.open` (W9/W2 call
 * it): `services.mcpEndpoint(threadId)` returns `{url, bearer}` for our own
 * loopback MCP route, so every harness browser call arrives as
 * `mcp__openade__browser_*` against a per-session credential.
 *
 * `hookEndpoint` returns a bearer + route shape for the same loopback server;
 * the entrypoint replaces it with the hook bridge's own per-thread endpoint
 * once that is built. `permissions.decide` forwards the thread and its live
 * modes to the permission ladder, and a failure there reads as "prompt" —
 * never as allow.
 */

import { mkdir } from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";

import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { configPath } from "@OpenAde/shared/paths";

import { PermissionService } from "../permissions/PermissionService";
import { McpGateway } from "./McpGateway";

export class SessionServices extends Context.Service<SessionServices, ConnectorServices>()(
  "server/mcp/SessionServices",
) {
  static readonly layer = Layer.effect(
    SessionServices,
    Effect.gen(function* () {
      const gateway = yield* McpGateway;
      const permissions = yield* PermissionService;
      const httpServer = yield* HttpServer.HttpServer;
      const clock = yield* Clock.Clock;

      const attachmentsDir = configPath(["attachments"]);
      yield* Effect.promise(() => mkdir(attachmentsDir, { recursive: true })).pipe(Effect.ignore);

      const httpBase = (): string => {
        const address = httpServer.address;
        return typeof address === "object" && address !== null && "port" in address
          ? `http://127.0.0.1:${address.port}`
          : "http://127.0.0.1:0";
      };

      return {
        mcpEndpoint: gateway.endpoint,
        hookEndpoint: (threadId) =>
          Effect.map(gateway.issueBearer(threadId), (bearer) => ({
            url: `${httpBase()}/hooks/pretooluse`,
            bearer,
          })),
        permissions: {
          decide: (input) =>
            permissions
              .decide({
                request: input.request,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                threadId: input.threadId,
              })
              // A permissions failure must never read as allow.
              .pipe(Effect.orElseSucceed((): "prompt" => "prompt")),
        },
        attachmentsDir,
        logger: {
          log: (level, message, data) =>
            (level === "debug"
              ? Effect.logDebug
              : level === "info"
                ? Effect.logInfo
                : level === "warn"
                  ? Effect.logWarning
                  : Effect.logError)(
              data === undefined ? message : `${message} ${JSON.stringify(data)}`,
            ),
        },
        clock,
      };
    }),
  );
}
