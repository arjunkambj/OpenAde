/**
 * What the Claude Code definition says about itself — the metadata and config
 * form `connectors.describe` serves — and what an instance of it offers.
 */

import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { replay } from "../test/replay";
import { testServices } from "../test/services";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { ClaudeConnectorConfig } from "./configSchema";
import { claudeConnectorDefinition } from "./definition";
import { CLAUDE_KIND } from "./kind";

describe("claudeConnectorDefinition", () => {
  it.effect("presents itself through its own metadata", () =>
    Effect.gen(function* () {
      const { kind, metadata } = yield* Effect.succeed(claudeConnectorDefinition);
      expect(kind).toBe(CLAUDE_KIND);
      expect(metadata.displayName).toBe("Claude Code");
      expect(metadata.iconKey).toBe("terminal");
      expect(metadata.accent).toMatch(/^#[0-9a-f]{6}$/i);
      // The CLI's own --help names no documentation link, so none is claimed.
      expect(metadata.docsUrl).toBeUndefined();
    }),
  );

  it.effect("describes its config form in declaration order", () =>
    Effect.gen(function* () {
      const erased = yield* Effect.sync(() => eraseConnectorDefinition(claudeConnectorDefinition));
      expect(
        erased.configFields.map((field) => [field.key, field.control, field.optional]),
      ).toEqual([
        ["binaryPath", "path", true],
        ["configDir", "path", true],
        ["defaultModel", "select", true],
      ]);
      expect(erased.configFields[1]?.description).toContain("CLAUDE_CONFIG_DIR");
      expect(erased.configFields[1]?.description).toContain("HOME is never changed");
    }),
  );

  it.effect("starts from an empty config the schema accepts", () =>
    Effect.gen(function* () {
      const config = claudeConnectorDefinition.defaultConfig();
      expect(yield* Schema.decodeUnknownEffect(ClaudeConnectorConfig)(config)).toEqual({});
    }),
  );

  it.effect("opens instances with the connector's capabilities", () =>
    Effect.gen(function* () {
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: {},
        services: yield* testServices(),
      });
      expect(instance.kind).toBe(CLAUDE_KIND);
      expect(instance.capabilities).toEqual(CLAUDE_CAPABILITIES);
      expect(instance.extensions).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("lists models once per instance: the handshake is a process start", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: replayed.binaryPath },
        services: yield* testServices(),
      });
      const first = yield* instance.listModels();
      const second = yield* instance.listModels();
      expect(second).toBe(first);
      expect(first[0]?.id).toBe("default");
      // One replayed handshake; a second launch would have found none left to play.
      expect(replayed.pids()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
