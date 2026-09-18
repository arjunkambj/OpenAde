/**
 * Scenario (d): plan mode, accepted and revised.
 *
 * A plan turn runs with `--permission-mode plan`, proposes a plan, and waits.
 * What the user does next decides the mode of the *following* turn, and that
 * is the claim worth making end to end: accepting a plan has to take the
 * thread out of plan mode, or the implementation turn proposes another plan
 * instead of doing the work. Revising keeps it there, which is the whole point
 * of the button.
 *
 * `fixtures/cmd/plan/` is the recording: a plan turn, then the accept
 * follow-up that implements it.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  autoApprove,
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

/** The two prompts `fixtures/cmd/plan/` was recorded on. */
const PROPOSE =
  "Plan how to add a subtract function to app.js, then call exit_plan_mode to present it.";
// The recording's second turn was prompted with "The plan is accepted.
// Implement it now." Nobody types that here: accepting the plan dispatches the
// implementation turn itself, naming the plan file it is implementing.

const SEED = { "app.js": "export const add = (a, b) => a + b;\n" };

const planMode = (driver: Driver) => {
  it.live("proposes a plan, and accepting it leaves plan mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("plan", SEED);
        yield* seedSettings(home, [driver.connector(home, "plan")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home, { interactionMode: "plan" });
        // The implementation turn accepting the plan starts edits a file, and
        // in approval-required mode that stops on a card. This scenario is
        // about the mode, not the gate, so the cards are answered for it.
        yield* autoApprove(client, open);

        const started = yield* startTurn(client, open, { text: PROPOSE });
        const proposed = yield* open.view.awaitValue(
          (view) => view.pendingPlan !== null || isSettled(view),
          started,
        );
        expect(proposed.pendingPlan).not.toBeNull();
        const plan = proposed.pendingPlan!;
        // A card with nothing in it is a card the user cannot judge.
        expect(plan.planMarkdown.length).toBeGreaterThan(0);
        expect(plan.turnId).toBe(proposed.currentTurnId ?? plan.turnId);
        // The thread is still in plan mode while the plan is on the table.
        expect(proposed.settings.interactionMode).toBe("plan");

        const accepted = yield* open.view.markAfter(
          yield* client.send(
            command({
              type: "thread.plan.respond",
              threadId: open.threadId,
              turnId: plan.turnId,
              action: "accept",
            }),
          ),
        );

        // Accepting does two things, and the user asks for
        // neither: it leaves plan mode, and it starts the implementation turn
        // naming the plan file. Without the mode reset that turn would spawn
        // `--permission-mode plan` again and answer a request to implement
        // with another plan.
        const implementing = yield* open.view.awaitAt(
          (view) => view.settings.interactionMode === "default" && view.currentTurnId !== null,
          accepted,
        );
        expect(implementing.value.pendingPlan).toBeNull();

        // And that turn runs to the end as an ordinary one. Measured from the
        // implementation turn's own start: the plan turn settles first, and a
        // wait for "settled" from before it would answer with that.
        const done = yield* open.view.awaitValue(isSettled, implementing.next);
        expect(done.settings.interactionMode).toBe("default");
        expect(done.pendingPlan).toBeNull();
        // A plan row on the timeline is what the pane renders the plan from.
        expect(done.items.some((item) => item.kind === "plan")).toBe(true);
        // The implementation turn is the thread's second user message, and the
        // user never typed it.
        const sent = done.items.filter((item) => item.kind === "user_message");
        expect(sent).toHaveLength(2);
        expect(sent.at(-1)!.text ?? "").toContain("Implement the approved plan");
      }),
    ),
  );

  it.live("revising keeps the thread in plan mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("plan-revise", SEED);
        yield* seedSettings(home, [driver.connector(home, "plan")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home, { interactionMode: "plan" });

        const started = yield* startTurn(client, open, { text: PROPOSE });
        const proposed = yield* open.view.awaitValue(
          (view) => view.pendingPlan !== null || isSettled(view),
          started,
        );
        expect(proposed.pendingPlan).not.toBeNull();

        const revised = yield* open.view.markAfter(
          yield* client.send(
            command({
              type: "thread.plan.respond",
              threadId: open.threadId,
              turnId: proposed.pendingPlan!.turnId,
              action: "revise",
              feedback: "Cover the subtraction edge cases too.",
            }),
          ),
        );

        // The card closes — the user has answered it — and a fresh planning
        // turn starts carrying the feedback, because "revise" means "plan
        // again", not "go ahead". The mode is what proves which of the two.
        const after = yield* open.view.awaitValue(
          (view) => view.pendingPlan === null && view.currentTurnId !== null,
          revised,
        );
        expect(after.settings.interactionMode).toBe("plan");
      }),
    ),
  );
};

forEachDriver("plan mode", planMode);
