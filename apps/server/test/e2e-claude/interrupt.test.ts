/**
 * Stop, on a harness whose one process serves the whole session.
 *
 * Claude Code's `Query.interrupt()` asks the running CLI to stop the request
 * in flight; it does not end the process. So the claims are the Command Code
 * ones plus what that implies: the stopped turn settles rather than hanging
 * or erroring, and the next message runs — in the same process, which is what
 * `fixtures/claude/interrupt/` showing a single session launch proves.
 *
 * Stop is pressed on an event, not a timer: once the answer's first text is on
 * screen. A replay writes everything the CLI said before it was interrupted
 * and then waits for the interrupt on stdin, so the moment is the same in
 * both drivers.
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

const LONG = "Count from 1 to 300, one number per line, and nothing else.";
const FOLLOW_UP = "Reply with exactly: ok";

claudeScenario(
  "stopping a Claude Code turn",
  {
    scenario: "interrupt",
    description:
      "A long answer interrupted once its first text had streamed, then a short follow-up in the same session: the interrupt ends the turn and the same CLI process answers the next message.",
    prompts: [LONG, FOLLOW_UP],
  },
  "settles the stopped turn and answers the next message in the same session",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client);

      const started = yield* startTurn(client, open, { text: LONG });
      const streaming = yield* open.view.awaitValue(
        (view) => view.currentTurnId !== null && assistantText(view).length > 0,
        started,
      );
      const stoppedTurn = streaming.currentTurnId;

      const stopped = yield* open.view.markAfter(
        yield* client.send(command({ type: "thread.turn.interrupt", threadId: open.threadId })),
      );
      const settled = yield* open.view.awaitValue(
        (view) => isSettled(view) && view.currentTurnId !== stoppedTurn,
        stopped,
      );
      expect(settled.status).not.toBe("error");
      expect(settled.items.some((item) => item.kind === "error")).toBe(false);
      // The count was cut short.
      expect(assistantText(settled)).not.toContain("300");

      const next = yield* startTurn(client, open, { text: FOLLOW_UP });
      const done = yield* open.view.awaitValue(
        (view) =>
          isSettled(view) &&
          view.items.filter((item) => item.kind === "assistant_message").length >= 2,
        next,
      );
      expect(done.status).not.toBe("error");
      const answers = done.items.filter((item) => item.kind === "assistant_message");
      expect((answers.at(-1)!.text ?? "").toLowerCase()).toContain("ok");

      // The same session carried both turns.
      const before = settled.session?.sessionRef as { readonly sessionId?: unknown } | undefined;
      const after = done.session?.sessionRef as { readonly sessionId?: unknown } | undefined;
      expect(after?.sessionId).toBe(before?.sessionId);
    }),
);
