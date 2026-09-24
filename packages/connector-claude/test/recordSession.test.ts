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
import type { ConnectorServices, TurnInput } from "@OpenAde/connector-sdk/definition";
import type { SessionHandle } from "@OpenAde/connector-sdk/sessionHandle";
import type { StreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import {
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
  type ThreadId,
} from "@OpenAde/contracts/ids";
import type { ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { resolveBinary } from "../src/binary";
import { makeClaudeConnectorDefinition } from "../src/definition";
import { CLAUDE_KIND } from "../src/kind";
import { parseVersion } from "../src/probe";
import { initModelOf, sdkVersion } from "./replay";
import { testServices } from "./services";

const RECORD = process.env.OPENADE_RECORD_CLAUDE === "1";
const SCRATCH = "/tmp/openade-h1/scratch";

const SIGNED_OUT_PROMPT = "Reply with the single word: ok";
const IMAGE_PROMPT = "What colour is the image? Answer with one word.";
const COMPACT = "/compact";
const STEER = "Also end your reply with the word banana.";

/** A fresh git repo for one scenario. */
const scratchRepo = (scenario: string): string => {
  const repo = NodePath.join(SCRATCH, scenario);
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# scratch\n", "utf8");
  return repo;
};

/** A 2×2 solid red PNG, the one the Command Code image recording was made with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

interface Recording {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
  readonly threadId: ThreadId;
  readonly services: ConnectorServices;
  /** What the CLI's `system/init` named so far, from the tee's capture. */
  readonly initModel: () => string | undefined;
}

/**
 * One session through the tee: `drive` sends its turns and settings, then the
 * session closes and the capture is finalised into `fixtures/claude/<scenario>/`.
 */
const recordScenario = (
  spec: {
    readonly scenario: string;
    readonly description: string;
    readonly prompts: ReadonlyArray<string>;
  },
  drive: (recording: Recording) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const real = resolveBinary({}, process.env);
      if (real === null) throw new Error("no claude binary to record");
      const cliVersion = parseVersion(
        execFileSync(real.command, ["--version"], { encoding: "utf8" }),
      );
      const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-raw-"));
      const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });

      const definition = makeClaudeConnectorDefinition({
        limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
      });
      const services = yield* testServices();
      const instance = yield* definition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: launcher },
        services,
      });
      const threadId = makeThreadId();
      const handle = yield* instance.startSession({
        threadId,
        projectId: makeProjectId(),
        workspaceRoot: scratchRepo(spec.scenario),
        settings: {
          model: "default",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);
      yield* drive({
        handle,
        collector,
        threadId,
        services,
        initModel: () => initModelOf(rawDir),
      });
      yield* handle.close();

      const dir = finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: spec.scenario,
        rawDir,
        description: spec.description,
        cliVersion: cliVersion ?? "unknown",
        sdkVersion: sdkVersion(),
        model: initModelOf(rawDir) ?? "default",
        prompts: spec.prompts,
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );

/** Sends one turn and waits for it to complete. */
const turn = (recording: Recording, text: string, attachments: TurnInput["attachments"] = []) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.send({ text, attachments, mentions: [] });
    yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/** Changes the session's settings and waits for the `model.changed` that answers. */
const switchTo = (recording: Recording, patch: ThreadSettingsPatch) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.updateSettings(patch);
    yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "model.changed",
    );
  });

describe("session recordings", () => {
  it.live.skipIf(!RECORD)("signed-out: one turn against a CLI that is not signed in", () =>
    recordScenario(
      {
        scenario: "signed-out",
        description:
          "One turn sent to a CLI that is not signed in: the CLI answers with its own sign-in error and an error result, without calling the API.",
        prompts: [SIGNED_OUT_PROMPT],
      },
      (recording) => turn(recording, SIGNED_OUT_PROMPT),
    ),
  );

  it.live.skipIf(!RECORD)(
    "signed-out-steer: a message steered into a running turn on a CLI that is not signed in",
    () =>
      recordScenario(
        {
          scenario: "signed-out-steer",
          description:
            "One turn on a CLI that is not signed in, with a second message steered into it once the CLI's system/init showed the turn under way: the CLI queues the steered message, refuses the first for the login with an error result, then runs the steered one as its own turn and refuses it the same way. Nothing reaches the API.",
          prompts: [SIGNED_OUT_PROMPT, STEER],
        },
        (recording) =>
          Effect.gen(function* () {
            const before = new Set(yield* recording.collector.collected);
            yield* recording.handle.send({
              text: SIGNED_OUT_PROMPT,
              attachments: [],
              mentions: [],
            });
            // The CLI announced the turn (its init): the turn is running.
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "mcp.status.updated",
            );
            yield* recording.handle.steer!({ text: STEER, attachments: [], mentions: [] });
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "turn.completed",
            );
          }),
      ),
  );

  it.live.skipIf(!RECORD)(
    "session-controls: the model, the effort, an image and /compact on a CLI that is not signed in",
    () =>
      recordScenario(
        {
          scenario: "session-controls",
          description:
            "One session on a CLI that is not signed in, so nothing reaches the API: a turn refused for the login; the model switched to the explicit id the CLI's init named for its default (set_model), the effort set to low (apply_flag_settings); a turn carrying a PNG as an image content block, refused; a /compact turn; and the model switched back to the default (set_model with no model).",
          prompts: [SIGNED_OUT_PROMPT, IMAGE_PROMPT, COMPACT],
        },
        (recording) =>
          Effect.gen(function* () {
            yield* turn(recording, SIGNED_OUT_PROMPT);
            const model = recording.initModel();
            if (model === undefined) throw new Error("the CLI never reported its model");
            yield* switchTo(recording, { model });
            yield* switchTo(recording, { effort: "low" });

            const dir = NodePath.join(recording.services.attachmentsDir, recording.threadId);
            NodeFS.mkdirSync(dir, { recursive: true });
            const png = NodePath.join(dir, "red.png");
            NodeFS.writeFileSync(png, Buffer.from(RED_PNG_BASE64, "base64"));
            yield* turn(recording, IMAGE_PROMPT, [
              { path: png, mime: "image/png", name: "red.png" },
            ]);

            yield* turn(recording, COMPACT);
            yield* switchTo(recording, { model: "default" });
          }),
      ),
  );
});
