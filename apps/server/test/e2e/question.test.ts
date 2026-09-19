/**
 * Scenario (c): the model asks the user a question.
 *
 * `ask_user_question` is the one tool whose answer is not a permission but a
 * choice, and print mode withholds it unless the argv asks for it — which is
 * why the connector passes `--tools-enable ask_user_question` and why there
 * are two recordings: `question/` is the argv before that flag, where the tool
 * simply never fires, and `question-tools/` is the connector's own argv, where
 * it does.
 *
 * The documented fallback is the interesting part of the path. A headless
 * harness has nobody to ask, so the answer travels back as a *denial* whose
 * reason carries the chosen options — the model reads it as context and
 * carries on. From the user's side none of that shows: a card appears, they
 * pick, the turn continues.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  bootServer,
  command,
  connect,
  forEachDriver,
  isSettled,
  makeHome,
  openThread,
  seedSettings,
  startTurn,
  staticCredentials,
  type Driver,
} from "./harness";

/** The prompt `fixtures/cmd/question-tools/` was recorded on. */
const ASK =
  "Use the ask_user_question tool to ask me whether I prefer tabs or spaces. Ask before doing anything else.";

const questions = (driver: Driver) => {
  it.live("opens a question card, takes the answer, and finishes the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("question");
        yield* seedSettings(home, [driver.connector(home, "question-tools")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home);

        const started = yield* startTurn(client, open, { text: ASK });

        // A model that answers in prose instead of calling the tool settles
        // the wait too, so this fails with what happened rather than hanging.
        const asked = yield* open.view.awaitValue(
          (view) => view.pendingUserInput !== null || isSettled(view),
          started,
        );
        if (asked.pendingUserInput === null) {
          // The documented fallback for a harness that withholds the tool: no
          // card, and the turn simply answers in text. Recorded as
          // `fixtures/cmd/question/`, and a legitimate outcome on a model that
          // will not call the tool — but it must not be silent about it.
          expect(isSettled(asked)).toBe(true);
          expect(
            asked.items.some((item) => item.kind === "assistant_message"),
            "the turn neither asked a question nor said anything",
          ).toBe(true);
          return;
        }

        const pending = asked.pendingUserInput;
        expect(pending.questions.length).toBeGreaterThan(0);
        const question = pending.questions[0]!;
        expect(question.question.length).toBeGreaterThan(0);
        // A card with no options is a card the user cannot answer.
        expect(question.options.length).toBeGreaterThan(0);

        const answered = yield* open.view.markAfter(
          yield* client.send(
            command({
              type: "thread.userInput.respond",
              threadId: open.threadId,
              requestId: pending.requestId,
              answers: [
                { questionId: question.questionId, optionIds: [question.options[0]!.optionId] },
              ],
            }),
          ),
        );

        const done = yield* open.view.awaitValue(isSettled, answered);
        expect(done.pendingUserInput).toBeNull();
        // The turn did not stall on the question it asked.
        expect(done.currentTurnId).toBeNull();
      }),
    ),
  );
};

forEachDriver("a question for the user", questions);
