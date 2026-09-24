/**
 * Scenario (e): Stop, and what the thread does next.
 *
 * Stop is the one control that has to work when everything else is busy, and
 * the promise it makes is not just "the turn ends": the thread has to still be
 * usable afterwards. Three claims, and the product failed the third until the
 * connector stopped resuming sessions the harness cannot resume:
 *
 * 1. the turn settles as interrupted rather than hanging or erroring;
 * 2. the thread takes the next message;
 * 3. a message queued *during* the turn — Cmd+Enter while it runs — starts by
 *    itself afterwards, with its attachments still on it. Command Code cannot
 *    take a message into a running turn, so a steer is refused with the
 *    reason that says to queue instead, and the queue is the way.
 *
 * `fixtures/cmd/interrupt-continue/` is the recording: a real SIGINT mid-run,
 * then the next message in a new session, because the interrupted run left no
 * transcript behind (`interrupt-resume/` is what happens if you try anyway).
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

/** The prompts `fixtures/cmd/interrupt-continue/` was recorded on. */
const LONG = "Count slowly from 1 to 200, one number per line, with a short comment on each.";
const FOLLOW_UP = "Never mind. Reply with exactly: ok";

/** A 1×1 PNG — enough to be a real staged file with a real sha. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const interrupts = (driver: Driver) => {
  it.live("settles the turn, then runs the message queued behind it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("interrupt", { "note.txt": "hello\n" });
        yield* seedSettings(home, [driver.connector(home, "interrupt-continue")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home);

        const started = yield* startTurn(client, open, { text: LONG });
        // The turn is really under way before Stop is pressed: interrupting a
        // turn the connector has not spawned yet proves nothing.
        const running = yield* open.view.awaitAt(
          (view) => view.currentTurnId !== null && view.items.length > 0,
          started,
        );
        const interruptedTurnId = running.value.currentTurnId;

        // Command Code says it cannot steer — which is why the composer
        // queues here — so the decider refuses a steer outright rather than
        // racing the running process, and says to queue instead.
        const connectors = yield* (yield* client.rpc)
          ["connectors.list"]({ refresh: false })
          .pipe(Effect.orDie);
        const cmd = connectors.find((entry) => entry.kind === "cmd");
        expect(cmd?.capabilities?.steering).toBe(false);
        const steer = yield* client.dispatch(
          command({
            type: "thread.turn.steer",
            threadId: open.threadId,
            text: FOLLOW_UP,
            attachments: [],
            mentions: [],
          }),
        );
        expect(steer.status).toBe("rejected");
        expect(steer.reason).toContain("queue it instead");

        // Cmd+Enter while it runs: the follow-up goes on the queue rather than
        // racing the session, and it carries an image.
        const staged = yield* (yield* client.rpc)
          ["attachments.stage"]({
            threadId: open.threadId,
            name: "queued.png",
            base64: PNG_BASE64,
          })
          .pipe(Effect.orDie);
        const queuedAt = yield* startTurn(client, open, {
          text: FOLLOW_UP,
          attachments: [{ path: staged.path, mime: staged.mime, name: staged.name }],
          queued: true,
        });
        const withQueue = yield* open.view.awaitValue((view) => view.queue.length > 0, queuedAt);
        expect(withQueue.queue).toHaveLength(1);
        // The attachment survives the queue — it is what the turn will send.
        expect(withQueue.queue[0]!.attachments).toHaveLength(1);
        expect(withQueue.queue[0]!.attachments[0]!.path).toBe(staged.path);

        const stopped = yield* open.view.markAfter(
          yield* client.send(command({ type: "thread.turn.interrupt", threadId: open.threadId })),
        );

        // The interrupted turn settles rather than hanging, and it does not
        // take the thread down with it.
        const settled = yield* open.view.awaitAt(
          (view) => view.currentTurnId !== interruptedTurnId,
          stopped,
        );
        expect(settled.value.status).not.toBe("error");

        // The queued message is dequeued and run without anyone asking again.
        // Counted on the timeline rather than on the queue: both the message
        // leaving the queue and the turn ending clear those fields, so only
        // the second user row says the follow-up really went out.
        const done = yield* open.view.awaitValue(
          (view) =>
            isSettled(view) && view.items.filter((i) => i.kind === "user_message").length === 2,
          stopped,
        );
        expect(done.queue).toEqual([]);
        // Two user messages: the one that was stopped and the one that was
        // queued behind it, with its attachment intact on the timeline.
        const sent = done.items.filter((item) => item.kind === "user_message");
        expect(sent).toHaveLength(2);
        expect(sent.at(-1)!.text).toBe(FOLLOW_UP);
        expect(sent.at(-1)!.attachments ?? []).toHaveLength(1);

        // The follow-up really ran: this is the turn that used to fail forever,
        // because its session id named a transcript the SIGINT never wrote.
        expect(done.items.some((item) => item.kind === "assistant_message")).toBe(true);
        expect(done.status).not.toBe("error");
      }),
    ),
  );
};

forEachDriver("stopping a turn", interrupts);
