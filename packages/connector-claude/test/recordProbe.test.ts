/**
 * Records `fixtures/claude/probe/` from the real CLI.
 *
 *     OPENADE_RECORD_CLAUDE=1 pnpm -F @OpenAde/connector-claude vitest run test/recordProbe.test.ts
 *
 * It runs the connector's own probe with its binary path pointed at the
 * testkit's stdio tee, so every launch — `--version`, `auth status --json`,
 * and the zero-turn SDK handshake that lists the models — is captured exactly
 * as the CLI answered, then finalised and scrubbed. The probe sends no
 * message to the API, so recording it costs nothing.
 *
 * Skipped unless asked for: it reads the operator's real CLI and account.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { resolveBinary } from "../src/binary";
import { CLAUDE_KIND } from "../src/kind";
import { probe } from "../src/probe";

const RECORD = process.env.OPENADE_RECORD_CLAUDE === "1";

/** The SDK's own version, read from the package the connector imports. */
const sdkVersion = (): string => {
  const entry = NodeURL.fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(entry), "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
};

describe("the probe recording", () => {
  it.effect.skipIf(!RECORD)("captures the real CLI's probe", () =>
    Effect.gen(function* () {
      const real = resolveBinary({}, process.env);
      if (real === null) throw new Error("no claude binary to record");
      const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-probe-raw-"));
      const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });

      const result = yield* probe({ binaryPath: launcher });
      expect(result.version).toBeDefined();

      const dir = finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: "probe",
        rawDir,
        description: `The connector's probe: --version, auth status --json, and the zero-turn SDK handshake that lists the models. No message is sent. Recorded ${result.auth === "present" ? "signed in" : "signed out"}.`,
        cliVersion: result.version!,
        sdkVersion: sdkVersion(),
        model: "default",
        prompts: [],
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );
});
