/**
 * The model asking the user a question on Claude Code, through the whole
 * server.
 *
 * AskUserQuestion reaches the connector's `canUseTool`, which opens OpenAde's
 * question card and holds the call until the user answers. The answer goes
 * back as the call's result, so the model carries on with it: here it writes
 * the chosen colour to colour.txt, whose edit card is answered for it.
 *
 * A replay runs no tool, so the file on disk is checked by the live and
 * record drivers; a replay checks the write the thread shows.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  autoApprove,
  command,
  connect,
  isSettled,
  startTurn,
  staticCredentials,
} from "../e2e/harness";
import { claudeScenario } from "./harness";

const ASK = "Ask me which colour to use with AskUserQuestion, then write it to colour.txt";

claudeScenario(
  "answering a Claude Code question",
  {
    scenario: "question",
    description:
      "The model asks which colour to use with AskUserQuestion; the question card is answered with its first option, and the model writes that colour to colour.txt, its edit card allowed once.",
    prompts: [ASK],
  },
  "opens the question card, and the answer reaches the model",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client);
      yield* autoApprove(client, open);

      const started = yield* startTurn(client, open, { text: ASK });
      const asked = yield* open.view.awaitValue(
        (view) => view.pendingUserInput !== null || isSettled(view),
        started,
      );
      expect(asked.pendingUserInput, "the model answered without asking").not.toBeNull();
      const pending = asked.pendingUserInput!;
      const question = pending.questions[0]!;
      expect(question.options.length).toBeGreaterThan(1);
      const choice = question.options[0]!;

      const answered = yield* open.view.markAfter(
        yield* client.send(
          command({
            type: "thread.userInput.respond",
            threadId: open.threadId,
            requestId: pending.requestId,
            answers: [{ questionId: question.questionId, optionIds: [choice.optionId] }],
          }),
        ),
      );
      const done = yield* open.view.awaitValue(isSettled, answered);
      expect(done.status).not.toBe("error");
      expect(done.pendingUserInput).toBeNull();
      expect(done.decisions?.find((decision) => decision.kind === "question")).toMatchObject({
        id: pending.requestId,
        outcome: "answered",
      });

      const write = done.items.find(
        (item) => item.kind === "file_change" && item.fileChange?.path.endsWith("colour.txt"),
      );
      expect(write?.status).toBe("completed");
      expect((write?.fileChange?.diff ?? "").toLowerCase()).toContain(choice.label.toLowerCase());
      if (run.driver !== "replay") {
        expect(
          NodeFS.readFileSync(
            NodePath.join(run.home.workspace, "colour.txt"),
            "utf8",
          ).toLowerCase(),
        ).toContain(choice.label.toLowerCase());
      }
    }),
);
