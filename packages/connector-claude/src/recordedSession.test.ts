/**
 * `makeClaudeSession` against `fixtures/claude/plain-reply/`: the session's
 * own launch from the end-to-end recording, replayed under the real SDK with
 * no server around it.
 *
 * Where `session.test.ts` covers a turn the CLI refuses, this is a turn the
 * model answered: streamed text settling as one assistant row, usage with a
 * cost, the context window, and a turn that ended `end_turn`. The recording
 * was made through the real server; only its session launch is played here —
 * the probe's launches are a different class and are never asked for.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@OpenAde/contracts/ids";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { recordingNames } from "@OpenAde/testkit/recording";
import { loadSdkStreamRecording } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";

const SCENARIO = "plain-reply";
const RECORDED = recordingNames(CLAUDE_KIND).includes(SCENARIO);

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

describe.skipIf(!RECORDED)(`a Claude Code session replaying claude/${SCENARIO}`, () => {
  it.live("answers the turn with streamed text, usage and end_turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recording = loadSdkStreamRecording(CLAUDE_KIND, SCENARIO);
        const prompt = recording.manifest.prompts[0]!;
        const replayed = replay(SCENARIO);
        const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
        const handle = yield* makeClaudeSession({
          instanceId: makeConnectorInstanceId(),
          threadId: makeThreadId(),
          workspaceRoot: workspace,
          binary: { command: replayed.binaryPath, display: replayed.binaryPath },
          env: childEnv(process.env, {}),
          loginCommand: `${replayed.binaryPath} auth login`,
          services: yield* testServices(),
          settings: {
            model: "default",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          limits: { maxTurns: 4, maxBudgetUsd: 0.5 },
        });
        const collector = yield* makeStreamCollector(handle.events);

        yield* handle.send({ text: prompt, attachments: [], mentions: [] });
        const completed = yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe(
          "end_turn",
        );
        expect(ofType(events, "runtime.error")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);

        // The answer streamed as deltas onto one row that the snapshot settled.
        const deltas = ofType(events, "content.delta");
        expect(deltas.length).toBeGreaterThan(0);
        const settled = ofType(events, "item.completed").filter(
          (event) => event.payload.item.kind === "assistant_message",
        );
        expect(settled).toHaveLength(1);
        expect((settled[0]!.payload.item.text ?? "").toLowerCase()).toContain("pong");
        expect(new Set(deltas.map((event) => event.payload.itemId))).toEqual(
          new Set([settled[0]!.payload.item.itemId]),
        );

        const usage = ofType(events, "usage.updated")[0]?.payload;
        expect(usage?.output).toBeGreaterThan(0);
        expect(usage?.costUsd).toBeGreaterThan(0);
        expect(ofType(events, "context.updated").length).toBeGreaterThan(0);

        yield* handle.close();
        yield* collector.awaitDone;
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();
      }),
    ),
  );
});
