/**
 * Scenario (a): a turn, from `project.create` to the answer on screen.
 *
 * This is the product's shortest complete path and the one every other
 * scenario builds on — a project, a thread, a prompt, and an assistant message
 * that streamed in as deltas and ended up as one row with usage against it.
 * Everything is real except the model: the server is `boot()`'s graph, the
 * client is `makeConnection` over a WebSocket, the view is the renderer's own
 * fold, and the connector spawns either the operator's `cmd` or a recording of
 * it.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assistantText,
  bootServer,
  command,
  connect,
  E2E_MODEL,
  forEachDriver,
  isSettled,
  makeHome,
  seedSettings,
  staticCredentials,
  type Driver,
} from "./harness";
import { watchThread, watchThreadList } from "./watch";
import { makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";

/** The prompt `fixtures/cmd/text/` was recorded on. */
const HELLO = "Reply with exactly: ok";

const helloTurn = (driver: Driver) => {
  it.live("streams an assistant answer into the thread and completes with usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("hello");
        yield* seedSettings(home, [driver.connector(home, "text")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));

        const projectId = makeProjectId();
        const threadId = makeThreadId();
        yield* client.send(
          command({
            type: "project.create",
            projectId,
            name: "e2e",
            workspaceRoot: home.workspace,
          }),
        );
        yield* client.send(
          command({ type: "thread.create", threadId, projectId, settings: { model: E2E_MODEL } }),
        );

        const thread = yield* watchThread(client.rpc, threadId);
        const list = yield* watchThreadList(client.rpc, projectId);

        yield* client.send(
          command({
            type: "thread.turn.start",
            threadId,
            text: HELLO,
            attachments: [],
            mentions: [],
            queued: false,
          }),
        );

        // The turn is over when the thread settles — no turn running and
        // nothing waiting on the user — which is exactly what the composer
        // re-enables on.
        const done = yield* thread.awaitValue(
          (view) => isSettled(view) && view.items.some((i) => i.kind === "assistant_message"),
        );

        // What the user asked for came back.
        expect(assistantText(done).toLowerCase()).toContain("ok");

        // One assistant row, not one per delta: the deltas coalesced.
        const assistant = done.items.filter((item) => item.kind === "assistant_message");
        expect(assistant).toHaveLength(1);
        expect(assistant[0]!.status).toBe("completed");

        // The prompt is on the timeline too, before the answer.
        const user = done.items.filter((item) => item.kind === "user_message");
        expect(user).toHaveLength(1);
        expect(done.items.indexOf(user[0]!)).toBeLessThan(done.items.indexOf(assistant[0]!));

        // Usage was accounted for, and the session is bound to a real ref.
        expect(done.usage).not.toBeNull();
        expect(done.usage!.input).toBeGreaterThan(0);
        expect(done.session).not.toBeNull();

        // The deltas coalesced rather than each arriving as its own row: every
        // successive answer the client held is a prefix of the next, growing
        // to the final text. A translator that emitted one item per
        // `text_delta` — or one that replaced the text instead of appending —
        // breaks this even though the last view would still look right.
        const texts = (yield* thread.all)
          .map((view) => assistantText(view))
          .filter((text) => text.length > 0);
        const growth = texts.filter((text, index) => index === 0 || text !== texts[index - 1]);
        for (const [index, text] of growth.entries()) {
          if (index > 0) {
            expect(growth[index - 1]!.length).toBeLessThan(text.length);
            expect(text.startsWith(growth[index - 1]!)).toBe(true);
          }
        }
        expect(growth.at(-1)).toBe(assistantText(done));

        // And the sidebar agrees: the thread is idle with a preview.
        const threads = yield* list.awaitValue((all) =>
          all.some((t) => t.threadId === threadId && t.status === "idle"),
        );
        const summary = threads.find((t) => t.threadId === threadId)!;
        expect(summary.status).toBe("idle");
        expect(summary.awaitingInput).toBe(false);
      }),
    ),
  );
};

forEachDriver("a turn end to end", helloTurn);
