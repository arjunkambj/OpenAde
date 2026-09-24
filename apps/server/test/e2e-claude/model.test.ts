/**
 * Switching a Claude Code thread's model and effort between turns, through
 * the whole server.
 *
 * One CLI process serves the session, so a switch is the SDK's `set_model`
 * and `apply_flag_settings` on that process — no restart — and the next turn
 * runs on what they set. The target is the explicit id of the model the CLI's
 * default already runs as, at a lower effort: the scenario never spends on a
 * model the operator did not approve. The replayer holds the connector to
 * both requests, in order, between the two turns.
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

const FIRST = "Reply with exactly: one";
const SECOND = "Reply with exactly: two";

claudeScenario(
  "switching a Claude Code thread's model and effort",
  {
    scenario: "model-switch",
    description:
      "Two turns in one session: the first on the CLI's default; then the thread's model switched to the explicit id the default runs as and its effort to low (set_model, apply_flag_settings, no restart); the second on those.",
    prompts: [FIRST, SECOND],
  },
  "switches in session, and the next turn runs on the switch",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client);

      const first = yield* startTurn(client, open, { text: FIRST });
      const answered = yield* open.view.awaitValue(
        (view) => isSettled(view) && assistantText(view).toLowerCase().includes("one"),
        first,
      );
      const session = answered.session?.sessionRef as { readonly sessionId?: string } | undefined;

      const model = yield* run.defaultModelId;
      const switched = yield* open.view.markAfter(
        yield* client.send(
          command({
            type: "thread.settings.update",
            threadId: open.threadId,
            model,
            effort: "low",
          }),
        ),
      );
      yield* open.view.awaitValue(
        (view) => view.settings.model === model && view.settings.effort === "low",
        switched,
      );

      const second = yield* startTurn(client, open, { text: SECOND });
      const done = yield* open.view.awaitValue(
        (view) => isSettled(view) && assistantText(view).toLowerCase().includes("two"),
        second,
      );
      expect(done.status).not.toBe("error");
      expect(done.settings).toMatchObject({ model, effort: "low" });
      // The same session served both turns: the switch restarted nothing.
      const after = done.session?.sessionRef as { readonly sessionId?: string } | undefined;
      expect(after?.sessionId).toBe(session?.sessionId);
    }),
);
