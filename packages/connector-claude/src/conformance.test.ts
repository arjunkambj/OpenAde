/**
 * The connector conformance suite, against the real CLI's recorded answers.
 *
 * Each case of `runConnectorConformance` opens its own session, so the
 * recording `fixtures/claude/conformance/` is the suite itself run through the
 * testkit's stdio tee: one session launch per case, in the suite's order. The
 * replay hands each case's launch the next recorded one, and exits 97 on any
 * line the connector sends that the recorded run was not sent.
 *
 *     OPENADE_RECORD_CLAUDE=1 pnpm -F @OpenAde/connector-claude vitest run src/conformance.test.ts
 *
 * records it again: the operator's CLI behind the tee, in a scratch repo under
 * `/tmp/openade-h1`, capped at one turn and a few cents a session.
 *
 * `isProcessGone` looks from outside, as the suite requires: in a replay, at
 * the pid every replayed process drops; in a recording, at the process groups
 * of the tee processes this file started.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runConnectorConformance } from "@OpenAde/connector-sdk/conformance";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import { afterAll } from "vitest";

import { initModelOf, isPidGone, replay, sdkVersion } from "../test/replay";
import { testServices } from "../test/services";
import { resolveBinary } from "./binary";
import { makeClaudeConnectorDefinition } from "./definition";
import { CLAUDE_KIND } from "./kind";
import { parseVersion } from "./probe";

const SCENARIO = "conformance";
const PROMPT = "Reply with exactly: ok";
const RECORD = process.env.OPENADE_RECORD_CLAUDE === "1";

/** The operator's CLI behind the tee, and what the manifest needs to say about it. */
const recorder = () => {
  const real = resolveBinary({}, process.env);
  if (real === null) throw new Error("no claude binary to record");
  const cliVersion = parseVersion(execFileSync(real.command, ["--version"], { encoding: "utf8" }));
  const root = "/tmp/openade-h1";
  NodeFS.mkdirSync(NodePath.join(root, "raw"), { recursive: true });
  const rawDir = NodeFS.mkdtempSync(NodePath.join(root, "raw", `${SCENARIO}-`));
  const scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(root, `${SCENARIO}-`)));
  const workspace = NodePath.join(scratch, "workspace");
  NodeFS.mkdirSync(workspace);
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
  /** Every process group a tee of this recording has led. */
  const groups = new Set<number>();
  const rows = (): ReadonlyArray<{ pid: number; pgid: number; command: string }> =>
    execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match === null
          ? []
          : [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }];
      });
  return {
    binaryPath: makeTeeLauncher({ realBinary: real.command, rawDir }),
    workspace,
    isGone: (): boolean => {
      const all = rows();
      for (const row of all) if (row.command.includes(rawDir)) groups.add(row.pgid);
      return !all.some((row) => groups.has(row.pgid));
    },
    finish: () =>
      finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: SCENARIO,
        rawDir,
        description:
          "The connector conformance suite, one session launch per case in the suite's order, each sent the same one-line prompt.",
        cliVersion: cliVersion ?? "unknown",
        sdkVersion: sdkVersion(),
        model: initModelOf(rawDir) ?? "default",
        prompts: [PROMPT],
        scratch,
      }),
  };
};

/** The recording behind the binary path. */
const replayer = () => {
  const replayed = replay(SCENARIO);
  const workspace = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-conformance-")),
    "workspace",
  );
  NodeFS.mkdirSync(workspace);
  return {
    binaryPath: replayed.binaryPath,
    workspace,
    isGone: (): boolean => replayed.pids().every(isPidGone),
    finish: () => replayed.assertPlayedOut(),
  };
};

const driver = RECORD ? recorder() : replayer();
afterAll(() => driver.finish());

runConnectorConformance(
  makeClaudeConnectorDefinition({ limits: { maxTurns: 1, maxBudgetUsd: 0.1 } }),
  {
    instanceId: makeConnectorInstanceId(),
    services: Effect.runSync(testServices()),
    config: { binaryPath: driver.binaryPath },
    session: {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: driver.workspace,
      settings: { model: "default", runtimeMode: "approval-required", interactionMode: "default" },
    },
    turn: { text: PROMPT, attachments: [], mentions: [] },
    isProcessGone: () => Effect.sync(driver.isGone),
  },
);
