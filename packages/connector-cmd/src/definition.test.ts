/**
 * What the Command Code definition says about itself: the metadata and config
 * form `connectors.describe` serves, which is everything the connectors page
 * knows about this connector.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CMD_KIND, cmdConnectorDefinition } from "./definition";

const recordedHelp = NodeFS.readFileSync(
  NodePath.resolve(
    NodeURL.fileURLToPath(import.meta.url),
    "../../../testkit/fixtures/cmd/probe/help.stdout.txt",
  ),
  "utf8",
);

describe("cmdConnectorDefinition", () => {
  it.effect("presents itself through its own metadata", () =>
    Effect.gen(function* () {
      const { metadata } = yield* Effect.succeed(cmdConnectorDefinition);
      expect(metadata.displayName).toBe("Command Code");
      expect(metadata.iconKey).toBe("terminal");
      expect(metadata.accent).toMatch(/^#[0-9a-f]{6}$/i);
      // The docs link is the one the CLI's own help names, not a guess.
      expect(metadata.docsUrl).toBeDefined();
      expect(recordedHelp).toContain(metadata.docsUrl);
    }),
  );

  it.effect("describes its config form in declaration order", () =>
    Effect.gen(function* () {
      const erased = yield* Effect.sync(() => eraseConnectorDefinition(cmdConnectorDefinition));
      expect(erased.kind).toBe(CMD_KIND);
      expect(erased.metadata).toBe(cmdConnectorDefinition.metadata);
      expect(
        erased.configFields.map((field) => [field.key, field.control, field.optional]),
      ).toEqual([
        ["binaryPath", "path", true],
        ["extraEnv", "keyValue", true],
        ["defaultModel", "select", true],
      ]);
      expect(erased.configFields[0]?.placeholder).toBe("cmd");
    }),
  );
});
