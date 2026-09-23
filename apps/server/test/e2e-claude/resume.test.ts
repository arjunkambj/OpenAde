/**
 * The server stops mid-thread and comes back, and the Claude Code conversation
 * goes on.
 *
 * The first server runs a turn and closes; its session's CLI process closes
 * with it. The second server, on the same home, reads the thread back from the
 * database, and the next turn resumes the CLI's own conversation by the
 * session id stored in the thread's `sessionRef` (`--resume`, the recording's
 * second session launch). It is a memory test on purpose: the second turn is
 * asked for a word only the first was told, which no fresh session could
 * answer. `fixtures/claude/resume/` is the recording.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { watchThread } from "../e2e/watch";
import { assistantText, connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

const REMEMBER = "Remember the word `pineapple`. Reply with exactly: stored";
const RECALL = "What word did I ask you to remember? Reply with just the word.";

claudeScenario(
  "a Claude Code session across a server restart",
  {
    scenario: "resume",
    description:
      "Two turns with the server stopped between them: the first session is closed with the server, and the second server resumes the CLI's conversation by its session id, which still knows what the first turn was told.",
    prompts: [REMEMBER, RECALL],
  },
  "resumes the CLI's conversation by the stored session id",
  (run) =>
    Effect.gen(function* () {
      // ── The first server ──
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* run.boot;
          const client = yield* connect(Effect.succeed(staticCredentials(server)));
          const open = yield* run.openThread(client);
          const started = yield* startTurn(client, open, { text: REMEMBER });
          const done = yield* open.view.awaitValue(
            (view) =>
              isSettled(view) && view.items.some((item) => item.kind === "assistant_message"),
            started,
          );
          expect(done.status).not.toBe("error");
          const ref = done.session?.sessionRef as { readonly sessionId?: string } | undefined;
          expect(typeof ref?.sessionId).toBe("string");
          return {
            threadId: open.threadId,
            projectId: open.projectId,
            sessionId: ref!.sessionId!,
            detail: done,
          };
        }),
      );

      // ── and the second, on the same home ──
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const view = yield* watchThread(client.rpc, before.threadId);
      const restored = yield* view.awaitValue(() => true);
      expect(restored.items.map((item) => item.itemId)).toEqual(
        before.detail.items.map((item) => item.itemId),
      );
      const ref = restored.session?.sessionRef as { readonly sessionId?: string } | undefined;
      expect(ref?.sessionId).toBe(before.sessionId);

      const open = { threadId: before.threadId, projectId: before.projectId, view };
      const started = yield* startTurn(client, open, { text: RECALL });
      const done = yield* view.awaitValue(
        (v) => isSettled(v) && v.items.filter((i) => i.kind === "user_message").length === 2,
        started,
      );
      expect(done.status).not.toBe("error");
      expect(done.items.some((item) => item.kind === "error")).toBe(false);
      expect(assistantText(done).toLowerCase()).toContain("pineapple");
      // Still the one conversation the CLI minted before the restart.
      const after = done.session?.sessionRef as { readonly sessionId?: string } | undefined;
      expect(after?.sessionId).toBe(before.sessionId);
    }),
);
