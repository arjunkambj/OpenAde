/**
 * Records session scenarios from the real CLI into `fixtures/claude/`.
 *
 *     OPENADE_RECORD_CLAUDE=1 pnpm -F @OpenAde/connector-claude vitest run test/recordSession.test.ts
 *
 * Each scenario drives the connector's real definition with its binary path
 * pointed at the testkit's stdio tee, in a throwaway git repo under
 * `/tmp/openade-h1/scratch`, capped by `maxTurns` and `maxBudgetUsd` so a live
 * run cannot spend beyond them. What the tee captured is finalised and
 * scrubbed into the scenario's directory.
 *
 * Skipped unless asked for: it runs the operator's real CLI and account.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { resolveBinary } from "../src/binary";
import { makeClaudeConnectorDefinition } from "../src/definition";
import { CLAUDE_KIND } from "../src/kind";
import { parseVersion } from "../src/probe";
import { initModelOf, sdkVersion } from "./replay";
import { testServices } from "./services";

const RECORD = process.env.OPENADE_RECORD_CLAUDE === "1";
const SCRATCH = "/tmp/openade-h1/scratch";

/** A fresh git repo for one scenario. */
const scratchRepo = (scenario: string): string => {
  const repo = NodePath.join(SCRATCH, scenario);
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# scratch\n", "utf8");
  return repo;
};

describe("session recordings", () => {
  it.live.skipIf(!RECORD)("signed-out: one turn against a CLI that is not signed in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const real = resolveBinary({}, process.env);
        if (real === null) throw new Error("no claude binary to record");
        const cliVersion = parseVersion(
          execFileSync(real.command, ["--version"], { encoding: "utf8" }),
        );
        const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-raw-"));
        const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });
        const prompt = "Reply with the single word: ok";

        const definition = makeClaudeConnectorDefinition({
          limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
        });
        const instance = yield* definition.createInstance({
          instanceId: makeConnectorInstanceId(),
          config: { binaryPath: launcher },
          services: yield* testServices(),
        });
        const handle = yield* instance.startSession({
          threadId: makeThreadId(),
          projectId: makeProjectId(),
          workspaceRoot: scratchRepo("signed-out"),
          settings: {
            model: "default",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        });
        const collector = yield* makeStreamCollector(handle.events);
        yield* handle.send({ text: prompt, attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        yield* handle.close();

        const dir = finalizeSdkStreamRecording({
          kind: CLAUDE_KIND,
          scenario: "signed-out",
          rawDir,
          description:
            "One turn sent to a CLI that is not signed in: the CLI answers with its own sign-in error and an error result, without calling the API.",
          cliVersion: cliVersion ?? "unknown",
          sdkVersion: sdkVersion(),
          model: initModelOf(rawDir) ?? "default",
          prompts: [prompt],
        });
        expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
      }),
    ),
  );
});
