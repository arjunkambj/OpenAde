/**
 * Steering a Claude Code turn, against `fixtures/claude/signed-out-steer/`.
 *
 * The recording was made on a CLI that was not signed in, so nothing reached
 * the API: a turn was sent, and once the CLI's `system/init` showed it under
 * way a second message was steered in. The CLI queued that message, ended the
 * first of its turns with an error result, then ran the steered message as a
 * turn of its own with a second result. That is the path where counting
 * results would end OpenAde's turn one message early. The replay holds the
 * session to writing the steered message exactly where the recording has it
 * — after the init, before the first result — and the turn has to span both.
 *
 * `fixtures/claude/receiptless-steer/` is the other side: an older CLI build
 * (2.1.150) whose `system/init` lists no `msg_lifecycle_v1` and which sends
 * no receipts. There a steered message that ran next would run as a turn
 * nobody opened, so the session refuses the steer, and says it cannot steer.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@OpenAde/contracts/ids";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { loadSdkStreamRecording } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";
import { addUsage, makeSteerLedger } from "./steering";
import { asRecord } from "./translate/pending";

const recording = loadSdkStreamRecording(CLAUDE_KIND, "signed-out-steer");
const [FIRST, STEERED] = recording.manifest.prompts as [string, string];
const frames = recording.invocations[0]!.frames;
const receiptless = loadSdkStreamRecording(CLAUDE_KIND, "receiptless-steer");
const receiptlessFrames = receiptless.invocations[0]!.frames;

/** A ledger that has read every frame the CLI sent in `list`. */
const ledgerOver = (list: typeof frames) => {
  const ledger = makeSteerLedger();
  for (const frame of list) if (frame.dir === "from-harness") ledger.observe(frame.data);
  return ledger;
};

/** Where each kind of frame sits in the recorded session. */
const positions = (match: (data: Record<string, unknown>) => boolean): Array<number> =>
  frames.flatMap((frame, index) => (match(asRecord(frame.data)) ? [index] : []));

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

describe("the recording steering rests on", () => {
  it("has the steered message written mid-turn and run as the CLI's next turn", () => {
    const users = positions((data) => data.type === "user");
    const inits = positions((data) => data.type === "system" && data.subtype === "init");
    const results = positions((data) => data.type === "result");
    expect(users).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(frames[users[1]!]!.dir).toBe("to-harness");
    // Written after the CLI announced the first turn, before that turn's result.
    expect(users[1]!).toBeGreaterThan(inits[0]!);
    expect(users[1]!).toBeLessThan(results[0]!);
    // Taken up only after that result: the CLI's second turn is the steered one.
    const steeredUuid = asRecord(frames[users[1]!]!.data).uuid;
    const startedAt = positions(
      (data) =>
        data.type === "command_lifecycle" &&
        data.command_uuid === steeredUuid &&
        data.state === "started",
    );
    expect(startedAt).toHaveLength(1);
    expect(startedAt[0]!).toBeGreaterThan(results[0]!);
    expect(startedAt[0]!).toBeLessThan(results[1]!);
  });
});

describe("makeSteerLedger", () => {
  /** The ledger over the recorded stream, asked at each result whether to hold. */
  const holdsAtResults = (watchSteered: boolean): Array<boolean> => {
    const ledger = makeSteerLedger();
    const steered = positions((data) => data.type === "user")[1]!;
    const answers: Array<boolean> = [];
    for (const [index, frame] of frames.entries()) {
      const data = asRecord(frame.data);
      if (frame.dir === "to-harness") {
        if (index === steered && watchSteered) ledger.watch(String(data.uuid));
        continue;
      }
      ledger.observe(frame.data);
      if (data.type === "result") answers.push(ledger.awaiting());
    }
    return answers;
  };

  it("holds the turn at the first result and ends it at the second", () => {
    expect(holdsAtResults(true)).toEqual([true, false]);
  });

  it("holds nothing when nothing was steered", () => {
    expect(holdsAtResults(false)).toEqual([false, false]);
  });

  it("knows nothing of receipts before the CLI has said anything", () => {
    expect(makeSteerLedger().receipts()).toBeUndefined();
  });

  it("knows the CLI sends receipts once it has", () => {
    expect(ledgerOver(frames).receipts()).toBe(true);
  });

  it("knows a CLI whose init lists no msg_lifecycle_v1 sends none", () => {
    expect(receiptless.manifest.cliVersion).toBe("2.1.150");
    const ledger = ledgerOver(receiptlessFrames);
    expect(ledger.receipts()).toBe(false);
    ledger.watch("never-reported");
    expect(ledger.awaiting()).toBe(false);
  });

  it("forgets what it watched once cleared", () => {
    const ledger = makeSteerLedger();
    ledger.observe(frames.find((frame) => asRecord(frame.data).type === "command_lifecycle")!.data);
    ledger.watch("steered");
    expect(ledger.awaiting()).toBe(true);
    ledger.clear();
    expect(ledger.awaiting()).toBe(false);
  });
});

describe("addUsage", () => {
  it("sums tokens and prices across a turn's results", () => {
    const one = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, costUsd: 0.25 };
    expect(addUsage(null, one)).toEqual(one);
    expect(addUsage(one, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toEqual({
      input: 4,
      output: 6,
      cacheRead: 8,
      cacheWrite: 12,
      costUsd: 0.25,
    });
    expect(
      addUsage(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("a Claude Code session replaying claude/signed-out-steer", () => {
  it("says it can steer", () => {
    expect(CLAUDE_CAPABILITIES.steering).toBe(true);
  });

  it.live("keeps one turn open until the steered message has been answered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replayed = replay("signed-out-steer");
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
          limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
        });
        const collector = yield* makeStreamCollector(handle.events);
        const steer = handle.steer!;

        // No turn to steer into yet: refused, and nothing is written.
        const idle = yield* Effect.flip(steer({ text: STEERED, attachments: [], mentions: [] }));
        expect(idle._tag).toBe("NotSteerable");

        yield* handle.send({ text: FIRST, attachments: [], mentions: [] });
        // The CLI's init: the turn is under way. The replayer waits here for
        // the steered message, as the CLI read it here.
        yield* collector.awaitItem((event) => event.type === "mcp.status.updated");
        yield* steer({ text: STEERED, attachments: [], mentions: [] });
        const completed = yield* collector.awaitItem((event) => event.type === "turn.completed");

        // Over now: a late steer is refused, for the caller to queue.
        const late = yield* Effect.flip(steer({ text: STEERED, attachments: [], mentions: [] }));
        expect(late._tag).toBe("NotSteerable");

        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        expect(replayed.pids()).toHaveLength(1);
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();

        // One turn, opened once and closed once, after both of the CLI's results.
        const started = ofType(events, "turn.started");
        expect(started).toHaveLength(1);
        expect(ofType(events, "turn.completed")).toEqual([completed]);
        if (completed.type !== "turn.completed") return;
        expect(completed.payload.turnId).toBe(started[0]!.payload.turnId);
        expect(completed.payload.stopReason).toBe("error");
        // Both messages were answered inside it: one refusal each, and the
        // CLI announced each of its two turns.
        const at = (event: RuntimeEvent) => events.indexOf(event);
        const errors = ofType(events, "runtime.error");
        expect(errors).toHaveLength(2);
        expect(errors.every((error) => at(error) < at(completed))).toBe(true);
        expect(ofType(events, "mcp.status.updated")).toHaveLength(2);
        // Each result's usage is the turn's, summed as it goes.
        const usage = ofType(events, "usage.updated");
        expect(usage).toHaveLength(2);
        expect(usage.every((event) => event.payload.turnId === completed.payload.turnId)).toBe(
          true,
        );
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

describe("a Claude Code session replaying claude/receiptless-steer", () => {
  it.live("refuses a steer on a CLI that sends no receipts, and says it cannot steer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replayed = replay("receiptless-steer");
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
          limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
        });
        const collector = yield* makeStreamCollector(handle.events);
        const [prompt] = receiptless.manifest.prompts as [string];

        yield* handle.send({ text: prompt, attachments: [], mentions: [] });
        // The CLI's init is in: the turn runs, and the CLI said it sends no receipts.
        yield* collector.awaitItem((event) => event.type === "mcp.status.updated");
        const refused = yield* Effect.flip(
          handle.steer!({ text: STEERED, attachments: [], mentions: [] }),
        );
        expect(refused._tag).toBe("NotSteerable");
        yield* collector.awaitItem((event) => event.type === "turn.completed");

        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        replayed.assertPlayedOut();

        // Unknown at the start, so the first announcement promises it; the
        // one after the turn knows better.
        const announced = ofType(events, "session.started");
        expect(announced.map((event) => event.payload.capabilities?.steering)).toEqual([
          true,
          false,
        ]);
        expect(ofType(events, "turn.completed")).toHaveLength(1);
      }),
    ),
  );
});
