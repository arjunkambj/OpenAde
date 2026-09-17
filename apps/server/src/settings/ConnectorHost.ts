/**
 * The `ConnectorServices` the host lends every connector instance.
 *
 * The connector manager opens instances while the layer graph is still being
 * built — before the HTTP server is listening, the hook bridge exists or the
 * permission ladder can resolve a thread's project. So the object handed to
 * `registry.open` is a stable façade whose endpoint-bearing members delegate
 * through a reference the entrypoint fills in with `install` once the running
 * app can supply them. Instances opened before that call pick the real
 * endpoints up on their next use rather than holding a dead one for life.
 *
 * Until `install` runs, asking for an endpoint is a defect naming the missing
 * piece — a crash a connector can report — and every permission decision is
 * `prompt`, which is the only safe default.
 *
 * This is the *only* `ConnectorServices` the server builds. A second bundle
 * used to exist beside it, and the two disagreed about which endpoints were
 * real; the one an instance was handed then depended on which code path opened
 * it. Everything a connector is lent — endpoints, permissions, the attachments
 * directory, the logger and the clock — is assembled here and nowhere else.
 */

import { mkdir } from "node:fs/promises";

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ConnectorLogLevel, ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { configPath } from "@OpenAde/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** The halves of `ConnectorServices` only the booted application can provide. */
export interface HostEndpoints {
  readonly mcpEndpoint: ConnectorServices["mcpEndpoint"];
  readonly hookEndpoint: ConnectorServices["hookEndpoint"];
  readonly registerHookHandler?: NonNullable<ConnectorServices["registerHookHandler"]>;
  readonly unregisterHookHandler?: NonNullable<ConnectorServices["unregisterHookHandler"]>;
  readonly permissions: ConnectorServices["permissions"];
}

const notWired = (what: string) =>
  Effect.die(new Error(`the connector ${what} endpoint is not wired yet`));

export class ConnectorHost extends Context.Service<
  ConnectorHost,
  {
    readonly services: ConnectorServices;
    /**
     * Installs the running app's endpoints. The entrypoint calls this once,
     * before the handshake lets any client in.
     */
    readonly install: (endpoints: HostEndpoints) => Effect.Effect<void>;
  }
>()("server/settings/ConnectorHost") {
  static readonly layer = Layer.effect(
    ConnectorHost,
    Effect.gen(function* () {
      const clock = yield* Effect.clockWith(Effect.succeed);
      const installed = yield* Ref.make<HostEndpoints | null>(null);
      const endpoints = Ref.get(installed);

      // Connectors are told to write attachments here; they should not each
      // have to create it, and a connector that cannot is a failed turn.
      //
      // Created by `install` rather than here. This layer is built by every
      // test that wires the manager graph, and `configPath` resolves against
      // the process's `OPENADE_HOME` — so creating it at build time made a
      // plain `vitest run` write into the developer's real `~/.openade`.
      // `install` is the booted app saying it is about to run turns, which is
      // the first moment a connector can be asked for the directory.
      const attachmentsDir = configPath(["attachments"]);

      const services: ConnectorServices = {
        mcpEndpoint: (threadId: ThreadId) =>
          Effect.flatMap(endpoints, (real) =>
            real === null ? notWired("MCP") : real.mcpEndpoint(threadId),
          ),
        hookEndpoint: (threadId: ThreadId) =>
          Effect.flatMap(endpoints, (real) =>
            real === null ? notWired("hook") : real.hookEndpoint(threadId),
          ),
        // Always present: whether a bridge exists is decided at install time,
        // not at open time, so the connector must not branch on `undefined`.
        registerHookHandler: (threadId, handler) =>
          Effect.flatMap(endpoints, (real) =>
            real?.registerHookHandler === undefined
              ? Effect.logWarning("no hook bridge installed; hook posts will not be answered")
              : real.registerHookHandler(threadId, handler),
          ),
        unregisterHookHandler: (threadId) =>
          Effect.flatMap(endpoints, (real) =>
            real?.unregisterHookHandler === undefined
              ? Effect.void
              : real.unregisterHookHandler(threadId),
          ),
        permissions: {
          // Safest default until the ladder is installed: everything asks.
          decide: (input) =>
            Effect.flatMap(endpoints, (real) =>
              real === null ? Effect.succeed("prompt" as const) : real.permissions.decide(input),
            ),
        },
        attachmentsDir,
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
      };

      return ConnectorHost.of({
        services,
        install: (real) =>
          Effect.andThen(
            Effect.promise(() => mkdir(attachmentsDir, { recursive: true })).pipe(Effect.ignore),
            Ref.set(installed, real),
          ),
      });
    }),
  );
}
