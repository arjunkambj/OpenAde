/**
 * Scenario (g): the server dies mid-thread and comes back.
 *
 * This is the desktop shell's ordinary Tuesday — the supervisor restarts a
 * crashed server, and the window is still open in front of it. Nothing about
 * the restart is cosmetic: the new process binds a different port and mints a
 * different token, so the renderer has to go back to the channel for fresh
 * credentials rather than loop against a dead socket, and the thread has to
 * come back from the database rather than from anything the old process held
 * in memory.
 *
 * What makes it more than a persistence test is the last part: the conversation
 * continues. The thread's `sessionRef` carries the real Command Code session
 * id, and the follow-up turn resumes it — so the model still knows what was
 * said before the crash.
 *
 * `fixtures/cmd/resume/` is the recording, and it is a memory test on purpose:
 * the first turn is told to remember a word and the second is asked for it
 * back, which no fresh session could answer.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  assistantText,
  awaitConnected,
  bootServer,
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
import { watchConnection, watchThread } from "./watch";
import type { ConnectionCredentials } from "@poseidon/client-runtime/connection";

/** The two prompts `fixtures/cmd/resume/` was recorded on. */
const REMEMBER = "Remember the word `pineapple`. Reply with exactly: stored";
const RECALL = "What word did I ask you to remember? Reply with just the word.";

const restarts = (driver: Driver) => {
  it.live("reconnects on new credentials and resumes the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("resume");
        yield* seedSettings(home, [driver.connector(home, "resume")]);

        // The renderer's own channel: credentials are re-read before every
        // connect attempt, so a supervisor that restarts the server leaves the
        // client dialling the new one rather than the port that just died.
        const channel = yield* Ref.make<ConnectionCredentials | null>(null);
        const client = yield* connect(Ref.get(channel));
        const states = yield* watchConnection(client.state);

        // ── The first server ──
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* bootServer(home);
            yield* Ref.set(channel, staticCredentials(first));
            // The position just past "we are up against this one". Taken here
            // rather than after the restart, because the state stream replays
            // its current value: a mark read before that arrives still points
            // at the connection to the server that is about to die.
            const up = yield* states.awaitAt((state) => state.status === "connected");
            const open = yield* openThread(client, home);
            const started = yield* startTurn(client, open, { text: REMEMBER });
            const done = yield* open.view.awaitValue(
              (view) => isSettled(view) && view.items.some((i) => i.kind === "assistant_message"),
              started,
            );
            expect(done.session).not.toBeNull();
            return {
              dropped: up.next,
              threadId: open.threadId,
              projectId: open.projectId,
              serverInstanceId: first.serverInstanceId,
              url: first.url,
              detail: done,
            };
          }),
        );

        // ── and the second, on the same home ──
        const second = yield* bootServer(home);
        expect(second.serverInstanceId).not.toBe(before.serverInstanceId);
        // A fresh port and a fresh token: the old ones are useless now, which
        // is the whole reason the client re-reads them.
        expect(second.url).not.toBe(before.url);
        yield* Ref.set(channel, staticCredentials(second));

        // The client comes back by itself and lands on the new instance. The
        // wait is on the connection state the reconnecting banner reads —
        // asking for anything sooner races the supervisor's own backoff.
        yield* awaitConnected(states, before.dropped);
        const hello = yield* (yield* client.rpc)["server.hello"]({}).pipe(Effect.orDie);
        expect(hello.serverInstanceId).toBe(second.serverInstanceId);

        // The thread is the one the user was looking at, item for item.
        const view = yield* watchThread(client.rpc, before.threadId);
        const after = yield* view.awaitValue(() => true);
        expect(after.items.map((item) => item.itemId)).toEqual(
          before.detail.items.map((item) => item.itemId),
        );
        expect(assistantText(after)).toBe(assistantText(before.detail));
        expect(after.checkpoints).toEqual(before.detail.checkpoints);

        // And the session it is bound to is the real one the CLI minted, not a
        // placeholder — which is what the follow-up turn resumes.
        expect(after.session).not.toBeNull();
        const ref = after.session!.sessionRef as { readonly sessionId?: unknown };
        expect(typeof ref.sessionId).toBe("string");
        expect(ref.sessionId).toBe(
          (before.detail.session!.sessionRef as { sessionId: string }).sessionId,
        );

        // The conversation continues across the restart: the recording's second
        // turn is asked for a word only the first turn was told.
        const open = {
          threadId: before.threadId,
          projectId: before.projectId,
          view,
        };
        const started = yield* startTurn(client, open, { text: RECALL });
        const done = yield* view.awaitValue(
          (v) => isSettled(v) && v.items.filter((i) => i.kind === "user_message").length === 2,
          started,
        );
        expect(done.status).not.toBe("error");
        expect(assistantText(done).toLowerCase()).toContain("pineapple");
      }),
    ),
  );
};

forEachDriver("a server restart", restarts);
