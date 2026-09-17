/**
 * The `ConnectorServices` the host lends every connector instance. W6 owns the
 * real MCP endpoint and W2 the hook bridge; until they land, both are wired to
 * a defect that names the missing piece — a connector that asks for one gets a
 * crash it can report rather than a URL that silently goes nowhere.
 */

import type { ConnectorLogLevel, ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { configPath } from "@OpenAde/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ConnectorHost extends Context.Service<
  ConnectorHost,
  {
    readonly services: ConnectorServices;
  }
>()("server/settings/ConnectorHost") {
  static readonly layer = Layer.effect(
    ConnectorHost,
    Effect.clockWith((clock) =>
      Effect.succeed(
        ConnectorHost.of({
          services: {
            mcpEndpoint: () =>
              Effect.die(new Error("connector MCP endpoint is not wired yet (W6)")),
            hookEndpoint: () =>
              Effect.die(new Error("connector hook endpoint is not wired yet (W2)")),
            permissions: {
              // Safest default until the permission bridge lands: everything asks.
              decide: () => Effect.succeed("prompt" as const),
            },
            attachmentsDir: configPath(["attachments"]),
            logger: {
              log: (level: ConnectorLogLevel, message: string, data) =>
                level === "debug"
                  ? Effect.logDebug(message, data)
                  : level === "info"
                    ? Effect.logInfo(message, data)
                    : level === "warn"
                      ? Effect.logWarning(message, data)
                      : Effect.logError(message, data),
            },
            clock,
          },
        }),
      ),
    ),
  );
}
