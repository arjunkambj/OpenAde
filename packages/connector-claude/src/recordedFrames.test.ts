/**
 * Every recorded Claude Code session, through the translator.
 *
 * `fixtures/claude/` holds what the real CLI said, line by line. This walks
 * every session launch of every recording and feeds the translator exactly
 * what the SDK would have handed the session — the CLI's stdout, minus the
 * control traffic the SDK answers itself — with the turn the session would
 * have had open at that point. A frame type the translator does not map shows
 * up here as `event.unmapped`, so a CLI release that starts saying something
 * new fails in the gate rather than going quietly missing from the timeline.
 *
 * Anything left unmapped has to be listed below with the reason it is.
 */

import { makeTurnId } from "@OpenAde/contracts/ids";
import { recordingNames } from "@OpenAde/testkit/recording";
import { loadSdkStreamRecording } from "@OpenAde/testkit/sdkStreamRecording";
import { describe, expect, it } from "vitest";

import { CLAUDE_KIND } from "./kind";
import { isBelowOldestTested, OLDEST_TESTED_VERSION } from "./probe";
import { methodOf, type Json } from "./translate/pending";
import { makeTranslator, type TurnContext } from "./translate/translator";

/**
 * Frames the translator leaves unmapped on purpose, by `methodOf` name, each
 * with its reason. Empty while every recorded frame has a mapping.
 */
const UNMAPPED_ON_PURPOSE: Readonly<Record<string, string>> = {};

/** What the SDK consumes itself and never yields to the session (its read loop). */
const SDK_OWN = new Set([
  "control_request",
  "control_response",
  "control_cancel_request",
  "keep_alive",
  "transcript_mirror",
]);

/**
 * Recordings made on an older build on purpose, each with its reason: they pin
 * how the connector treats a CLI below the floor, which it runs with a warning.
 */
const BELOW_FLOOR_ON_PURPOSE: Readonly<Record<string, string>> = {
  "receiptless-steer": "a CLI with no msg_lifecycle_v1 receipts, which cannot be steered",
};

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object";

/** The recordings with at least one session launch — a probe's handshake keeps none. */
const sessions = [...recordingNames(CLAUDE_KIND), "probe"].flatMap((scenario) =>
  loadSdkStreamRecording(CLAUDE_KIND, scenario).invocations.flatMap((invocation) =>
    invocation.argv.includes("stream-json") && !invocation.argv.includes("--no-session-persistence")
      ? [{ scenario, file: invocation.file, frames: invocation.frames }]
      : [],
  ),
);

describe("the recorded Claude Code sessions", () => {
  it("were all recorded at or above the oldest tested CLI version, but the older ones on purpose", () => {
    for (const scenario of [...recordingNames(CLAUDE_KIND), "probe"]) {
      const { manifest } = loadSdkStreamRecording(CLAUDE_KIND, scenario);
      expect(isBelowOldestTested(manifest.cliVersion), `${scenario}: ${manifest.cliVersion}`).toBe(
        scenario in BELOW_FLOOR_ON_PURPOSE,
      );
    }
    expect(OLDEST_TESTED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("include at least one session", () => {
    expect(sessions.length).toBeGreaterThan(0);
  });

  it.each(sessions.map((session) => [`${session.scenario}/${session.file}`, session] as const))(
    "%s translates with nothing unmapped",
    (_, session) => {
      const translator = makeTranslator({
        loginCommand: "claude auth login",
        previousTotalCost: 0,
      });
      let turn: TurnContext | null = null;
      const unmapped: Array<string> = [];
      for (const frame of session.frames) {
        const data = frame.data;
        if (!isObject(data)) continue;
        if (frame.dir === "to-harness") {
          if (data.type === "user" && turn === null) {
            turn = { turnId: makeTurnId(), interrupted: false };
          }
          if (
            data.type === "control_request" &&
            isObject(data.request) &&
            data.request.subtype === "interrupt" &&
            turn !== null
          ) {
            turn = { ...turn, interrupted: true };
          }
          continue;
        }
        if (frame.channel !== "stdout" || SDK_OWN.has(String(data.type))) continue;
        for (const event of translator.translate(data, turn)) {
          if (event.type === "event.unmapped") unmapped.push(methodOf(data));
          if (event.type === "turn.completed") turn = null;
        }
      }
      expect(unmapped.filter((method) => UNMAPPED_ON_PURPOSE[method] === undefined)).toEqual([]);
    },
  );
});
