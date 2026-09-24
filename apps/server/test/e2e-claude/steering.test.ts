/**
 * Steering: a message sent while a turn runs goes into that turn, through the
 * whole product.
 *
 * Claude Code says it can steer, so the composer's Enter during a running
 * turn dispatches `thread.turn.steer` rather than queueing. The claims:
 *
 * - the thread's session carries `steering: true`, the capability the
 *   composer and the decider read;
 * - the steer is accepted while the turn runs, and its user row lands on the
 *   timeline inside that turn — the thread never has a second turn id;
 * - the queue stays empty from start to finish;
 * - the one answer honours both messages: it ran the command the first asked
 *   for and ends with the word the steered one asked for.
 *
 * The steer is sent on an event, not a timer: once the shell command's row is
 * on screen. The command sleeps for five seconds, so live the message lands
 * while the agent loop is still busy; a replay writes everything the CLI said
 * before it read the message and then waits for it on stdin, so the moment is
 * the same in both drivers. The turn runs under full access, so no card can
 * stand between the command and the steer.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assistantText,
  command,
  connect,
  isSettled,
  startTurn,
  staticCredentials,
} from "../e2e/harness";
import { claudeScenario } from "./harness";

const PROMPT = "Run `sleep 5; echo one` then summarise.";
const STEER = "Also end your reply with the word banana.";

claudeScenario(
  "steering a Claude Code turn",
  {
    scenario: "steering",
    description:
      "Full access: a turn that runs `sleep 5; echo one`, with a second message steered in once the command's row was on screen. The CLI takes the steered message into the running turn, and the one turn's answer ends with the word it asked for.",
    prompts: [PROMPT, STEER],
  },
  "takes the steered message into the running turn and answers both in one turn",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "full-access" });

      const started = yield* startTurn(client, open, { text: PROMPT });
      const running = yield* open.view.awaitValue(
        (view) =>
          view.currentTurnId !== null &&
          view.items.some((item) => item.kind === "command_execution"),
        started,
      );
      const turnId = running.currentTurnId;
      expect(running.session?.capabilities?.steering).toBe(true);

      // Enter while the turn runs, on a harness that steers.
      const steered = yield* open.view.markAfter(
        yield* client.send(
          command({
            type: "thread.turn.steer",
            threadId: open.threadId,
            text: STEER,
            attachments: [],
            mentions: [],
          }),
        ),
      );
      const done = yield* open.view.awaitValue(
        (view) =>
          isSettled(view) && view.items.filter((item) => item.kind === "user_message").length === 2,
        steered,
      );
      expect(done.status).not.toBe("error");
      expect(done.items.some((item) => item.kind === "error")).toBe(false);

      // Both messages are on the timeline, the steered one after the command
      // started and before the answer that honours it.
      const users = done.items.filter((item) => item.kind === "user_message");
      expect(users.map((item) => item.text)).toEqual([PROMPT, STEER]);
      const answers = done.items.filter((item) => item.kind === "assistant_message");
      const shell = done.items.find((item) => item.kind === "command_execution");
      expect(done.items.indexOf(users[1]!)).toBeGreaterThan(done.items.indexOf(shell!));
      expect(done.items.indexOf(users[1]!)).toBeLessThan(done.items.indexOf(answers.at(-1)!));
      expect(assistantText(done).toLowerCase()).toContain("banana");

      // One turn from start to finish, and nothing ever queued.
      const views = yield* open.view.since(started);
      const turnIds = new Set(views.flatMap((view) => view.currentTurnId ?? []));
      expect([...turnIds]).toEqual([turnId]);
      expect(views.every((view) => view.queue.length === 0)).toBe(true);
    }),
);
