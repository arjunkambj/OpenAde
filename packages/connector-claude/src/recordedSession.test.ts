/**
 * `makeClaudeSession` against the end-to-end recordings: each scenario's own
 * session launch, replayed under the real SDK with no server around it.
 *
 * Where `session.test.ts` covers a turn the CLI refuses, these are turns the
 * model worked through. `plain-reply`: streamed text settling as one assistant
 * row, usage with a cost, the context window, and a turn that ended
 * `end_turn`. The approval scenarios: the tool rows, the cards the gate opened
 * and how each was answered — every card resolved, no call run past the gate.
 * The recordings were made through the real server; only their session launch
 * is played here — the probe's launches are a different class and are never
 * asked for.
 *
 * The ladder here stands in for the server's, as far as these recordings
 * need it: a sensitive path asks, a read passes, full access passes the rest,
 * and anything else asks. The replay checks every hook answer and every card
 * answer against the recorded one, so a ladder that answered differently from
 * the server's would fail the replay, not pass it quietly.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ConnectorPermissions } from "@OpenAde/connector-sdk/definition";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import type { ApprovalDecision, RuntimeMode } from "@OpenAde/contracts/enums";
import { makeConnectorInstanceId, makeThreadId, type RequestId } from "@OpenAde/contracts/ids";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { recordingNames } from "@OpenAde/testkit/recording";
import { loadSdkStreamRecording } from "@OpenAde/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";

const recorded = (scenario: string): boolean => recordingNames(CLAUDE_KIND).includes(scenario);

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

/** The server's ladder, as far as these recordings go (see the header). */
const ladder: ConnectorPermissions["decide"] = ({ request, runtimeMode }) =>
  Effect.succeed(
    JSON.stringify(request.input ?? {}).includes(".env")
      ? "prompt"
      : request.kind === "file_read" || runtimeMode === "full-access"
        ? "allow"
        : "prompt",
  );

/**
 * Replays one scenario's session: its first prompt, every card answered with
 * `answer`, until the turn completes. Answers with every event the session
 * emitted, after proving the session closed, its processes gone and the
 * recording played out.
 */
const replayTurn = (
  scenario: string,
  runtimeMode: RuntimeMode,
  answer: ApprovalDecision,
): Effect.Effect<ReadonlyArray<RuntimeEvent>, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const recording = loadSdkStreamRecording(CLAUDE_KIND, scenario);
    const prompt = recording.manifest.prompts[0]!;
    const replayed = replay(scenario);
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
    const handle = yield* makeClaudeSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: workspace,
      binary: { command: replayed.binaryPath, display: replayed.binaryPath },
      env: childEnv(process.env, {}),
      loginCommand: `${replayed.binaryPath} auth login`,
      services: yield* testServices({ decide: ladder }),
      settings: { model: "default", runtimeMode, interactionMode: "default" },
      limits: { maxTurns: 4, maxBudgetUsd: 0.5 },
    });
    const collector = yield* makeStreamCollector(handle.events);

    // The user at the card: every request the turn opens, answered the same.
    const answered = new Set<RequestId>();
    const answerAll: Effect.Effect<void, unknown> = collector
      .awaitItem(
        (event) =>
          event.type === "request.opened" && !answered.has(event.payload.request.requestId),
      )
      .pipe(
        Effect.flatMap((event) => {
          if (event.type !== "request.opened") return Effect.void;
          answered.add(event.payload.request.requestId);
          return handle.respondToRequest(event.payload.request.requestId, answer);
        }),
        Effect.andThen(Effect.suspend(() => answerAll)),
      );
    yield* Effect.forkScoped(Effect.ignore(answerAll));

    yield* handle.send({ text: prompt, attachments: [], mentions: [] });
    yield* collector.awaitItem((event) => event.type === "turn.completed");
    yield* handle.close();
    yield* collector.awaitDone;
    expect(replayed.pids().every(isPidGone)).toBe(true);
    replayed.assertPlayedOut();
    return yield* collector.collected;
  });

/** What every gated turn owes: no card left open, nothing unmapped, nothing ungated. */
const expectGated = (events: ReadonlyArray<RuntimeEvent>) => {
  const opened = ofType(events, "request.opened").map((event) => event.payload.request.requestId);
  const resolved = new Set(ofType(events, "request.resolved").map((e) => e.payload.requestId));
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.filter((id) => !resolved.has(id))).toEqual([]);
  expect(ofType(events, "event.unmapped")).toEqual([]);
  expect(ofType(events, "session.warning")).toEqual([]);
};

/** The settled snapshot of every row of `kind`. */
const rows = (events: ReadonlyArray<RuntimeEvent>, kind: string) =>
  ofType(events, "item.completed")
    .map((event) => event.payload.item)
    .filter((item) => item.kind === kind);

describe.skipIf(!recorded("plain-reply"))(
  "a Claude Code session replaying claude/plain-reply",
  () => {
    it.live("answers the turn with streamed text, usage and end_turn", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* replayTurn("plain-reply", "approval-required", "deny");
          const completed = ofType(events, "turn.completed")[0];
          expect(completed?.payload.stopReason).toBe("end_turn");
          expect(ofType(events, "runtime.error")).toEqual([]);
          expect(ofType(events, "event.unmapped")).toEqual([]);

          // The answer streamed as deltas onto one row that the snapshot settled.
          const deltas = ofType(events, "content.delta");
          expect(deltas.length).toBeGreaterThan(0);
          const settled = rows(events, "assistant_message");
          expect(settled).toHaveLength(1);
          expect((settled[0]!.text ?? "").toLowerCase()).toContain("pong");
          expect(new Set(deltas.map((event) => event.payload.itemId))).toEqual(
            new Set([settled[0]!.itemId]),
          );

          const usage = ofType(events, "usage.updated")[0]?.payload;
          expect(usage?.output).toBeGreaterThan(0);
          expect(usage?.costUsd).toBeGreaterThan(0);
          expect(ofType(events, "context.updated").length).toBeGreaterThan(0);
        }),
      ),
    );
  },
);

describe.skipIf(!recorded("edit-approval"))(
  "a Claude Code session replaying claude/edit-approval",
  () => {
    it.live("asks before the write, and settles the write as a file change once allowed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* replayTurn("edit-approval", "approval-required", "allow-once");
          expectGated(events);
          const first = ofType(events, "request.opened")[0]!.payload.request;
          expect(first.kind).toBe("file_write");
          expect(first.patternSuggestion).toMatch(/^Edit\(.*hello\.txt\)$/);

          const write = rows(events, "file_change").find((item) =>
            item.fileChange?.path.endsWith("hello.txt"),
          );
          expect(write?.status).toBe("completed");
          expect(write?.fileChange?.diff).toContain("+hi");
          // The row settled only after the card was answered.
          const resolvedAt = events.findIndex((event) => event.type === "request.resolved");
          const settledAt = events.findIndex(
            (event) =>
              event.type === "item.completed" && event.payload.item.itemId === write?.itemId,
          );
          expect(settledAt).toBeGreaterThan(resolvedAt);
        }),
      ),
    );
  },
);

describe.skipIf(!recorded("deny"))("a Claude Code session replaying claude/deny", () => {
  it.live("fails the denied command's row and tells the model it was refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replayTurn("deny", "approval-required", "deny");
        expectGated(events);
        expect(ofType(events, "request.opened")[0]!.payload.request).toMatchObject({
          kind: "command",
          toolName: "Bash",
          patternSuggestion: "Shell(touch *)",
        });
        const shell = rows(events, "command_execution");
        expect(shell.length).toBeGreaterThan(0);
        expect(shell.every((item) => item.status === "failed")).toBe(true);
      }),
    ),
  );
});

describe.skipIf(!recorded("sensitive-full-access"))(
  "a Claude Code session replaying claude/sensitive-full-access",
  () => {
    it.live("opens a card for .env under full access", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* replayTurn("sensitive-full-access", "full-access", "deny");
          expectGated(events);
          const first = ofType(events, "request.opened")[0]!.payload.request;
          expect(JSON.stringify(first.input)).toContain(".env");
          expect(JSON.stringify(events)).not.toContain("not-a-real-key");
        }),
      ),
    );
  },
);
