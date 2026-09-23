/**
 * What the connector's tests lend a session in place of the server: a
 * permission ladder that answers one fixed verdict (or the test's own), an MCP endpoint nothing
 * listens on, a throwaway attachments directory, and a silent logger.
 *
 * The MCP URL points at the discard port on loopback, so the CLI's connection
 * attempt is refused at once and the session's own traffic is all that runs.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  ConnectorPermissions,
  ConnectorServices,
  PermissionDecision,
} from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";

export const UNREACHABLE_MCP = {
  url: "http://127.0.0.1:9/mcp",
  bearer: "openade-test-bearer-0000",
} as const;

export const testServices = (
  options: {
    readonly decision?: PermissionDecision;
    /** A ladder of the test's own, in place of the one fixed verdict. */
    readonly decide?: ConnectorPermissions["decide"];
  } = {},
): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.sync((): ConnectorServices => ({
      mcpEndpoint: () => Effect.succeed(UNREACHABLE_MCP),
      hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:9/hooks", bearer: "unused" }),
      permissions: {
        decide: options.decide ?? (() => Effect.succeed(options.decision ?? "prompt")),
      },
      attachmentsDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-")),
      logger: { log: () => Effect.void },
      clock,
    })),
  );
