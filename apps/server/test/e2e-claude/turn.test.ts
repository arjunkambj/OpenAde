/**
 * A Claude Code turn, from `project.create` to the answer on screen.
 *
 * The shortest complete path through the product on this harness: a thread on
 * the CLI's default model, a prompt, and an assistant message that streamed in
 * as deltas and settled as one row, with usage and the session the connector
 * minted bound to the thread. `fixtures/claude/plain-reply/` is the recording.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { assistantText, connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

const PROMPT = "Reply with exactly: pong";

claudeScenario(
  "a Claude Code turn end to end",
  {
    scenario: "plain-reply",
    description:
      "One turn on the CLI's default model through the real server: a short prompt answered with one streamed assistant message and a success result.",
    prompts: [PROMPT],
  },
  "streams the answer into one assistant row and completes with usage",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client);

      const started = yield* startTurn(client, open, { text: PROMPT });
      const done = yield* open.view.awaitValue(
        (view) => isSettled(view) && view.items.some((item) => item.kind === "assistant_message"),
        started,
      );

      expect(assistantText(done).toLowerCase()).toContain("pong");
      expect(done.status).not.toBe("error");
      expect(done.items.some((item) => item.kind === "error")).toBe(false);

      // One assistant row, completed, after the prompt.
      const assistant = done.items.filter((item) => item.kind === "assistant_message");
      expect(assistant).toHaveLength(1);
      expect(assistant[0]!.status).toBe("completed");
      const user = done.items.filter((item) => item.kind === "user_message");
      expect(user).toHaveLength(1);
      expect(done.items.indexOf(user[0]!)).toBeLessThan(done.items.indexOf(assistant[0]!));

      // Usage was accounted, and the thread is bound to the CLI's session.
      expect(done.usage).not.toBeNull();
      expect(done.usage!.output).toBeGreaterThan(0);
      const ref = done.session?.sessionRef as { readonly sessionId?: unknown } | undefined;
      expect(typeof ref?.sessionId).toBe("string");

      // The deltas coalesced: every answer the client held is a prefix of the
      // next, growing to the final text.
      const texts = (yield* open.view.all)
        .map((view) => assistantText(view))
        .filter((text) => text.length > 0);
      const growth = texts.filter((text, index) => index === 0 || text !== texts[index - 1]);
      for (const [index, text] of growth.entries()) {
        if (index > 0) expect(text.startsWith(growth[index - 1]!)).toBe(true);
      }
      expect(growth.at(-1)).toBe(assistantText(done));
    }),
);
