/**
 * A session's controls against `fixtures/claude/session-controls/`: the model
 * and the effort changed inside one running CLI, an image sent with a turn,
 * and `/compact`, replayed behind the binary path under the real SDK.
 *
 * The recording was made on a CLI that was not signed in, so no turn reached
 * the API and nothing was spent; what it shows is the session's own traffic.
 * The CLI took `set_model` — the explicit id its init named for the default,
 * and then no model at all, the default again — and `apply_flag_settings`
 * with an effort level, each without a restart; it read the image turn's
 * content blocks as a user message; and it ran `/compact` as the command,
 * which failed for want of a login. The replayer holds the session to every
 * one of those requests in order, so a session that restarted the CLI to
 * switch, or never asked, fails the replay.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";

const recording = loadSdkStreamRecording(CLAUDE_KIND, "session-controls");
const [REFUSED, IMAGE, COMPACT] = recording.manifest.prompts as [string, string, string];
/** The explicit id the CLI's init named for its default model. */
const DEFAULT_ID = recording.manifest.model;

const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

describe("a Claude Code session's controls, replaying claude/session-controls", () => {
  it.live("switches model and effort in session, sends an image, and runs /compact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replayed = replay("session-controls");
        const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
        const services = yield* testServices();
        const threadId = makeThreadId();
        const handle = yield* makeClaudeSession({
          instanceId: makeConnectorInstanceId(),
          threadId,
          workspaceRoot: workspace,
          binary: { command: replayed.binaryPath, display: replayed.binaryPath },
          env: childEnv(process.env, {}),
          loginCommand: `${replayed.binaryPath} auth login`,
          services,
          settings: {
            model: "default",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
        });
        const collector = yield* makeStreamCollector(handle.events);

        const turn = (text: string, attachments: ReadonlyArray<{ path: string }> = []) =>
          Effect.gen(function* () {
            const before = new Set(yield* collector.collected);
            yield* handle.send({ text, attachments, mentions: [] });
            yield* collector.awaitItem(
              (event) => !before.has(event) && event.type === "turn.completed",
            );
          });
        const switchTo = (patch: ThreadSettingsPatch) =>
          Effect.gen(function* () {
            const before = new Set(yield* collector.collected);
            yield* handle.updateSettings(patch);
            return yield* collector.awaitItem(
              (event) => !before.has(event) && event.type === "model.changed",
            );
          });

        yield* turn(REFUSED);
        const explicit = yield* switchTo({ model: DEFAULT_ID });
        const effort = yield* switchTo({ effort: "low" });

        const png = NodePath.join(services.attachmentsDir, threadId, "red.png");
        NodeFS.mkdirSync(NodePath.dirname(png), { recursive: true });
        NodeFS.writeFileSync(png, Buffer.from(RED_PNG_BASE64, "base64"));
        yield* turn(IMAGE, [{ path: png }]);
        yield* turn(COMPACT);
        const back = yield* switchTo({ model: "default" });

        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        expect(replayed.pids()).toHaveLength(1);
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();

        // Each switch said what the CLI now runs on, in the one process.
        expect(explicit.payload).toEqual({ model: DEFAULT_ID });
        expect(effort.payload).toEqual({ model: DEFAULT_ID, effort: "low" });
        expect(back.payload).toEqual({ model: "default", effort: "low" });
        expect(yield* handle.sessionRef()).toMatchObject({ cwd: workspace });

        // Three turns, the image staged without a warning, nothing unmapped.
        expect(ofType(events, "turn.completed")).toHaveLength(3);
        expect(ofType(events, "session.warning")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);

        // `/compact` ran as the command: a compaction row, failed with the CLI's line.
        const compactions = ofType(events, "item.completed")
          .map((event) => event.payload.item)
          .filter((item) => item.kind === "context_compaction");
        expect(compactions).toHaveLength(1);
        expect(compactions[0]!.status).toBe("failed");
        expect(compactions[0]!.error?.message).toContain("Error during compaction");
        const started = ofType(events, "item.started").find(
          (event) => event.payload.item.itemId === compactions[0]!.itemId,
        );
        expect(started?.payload.item.status).toBe("in_progress");
      }),
    ),
  );
});
