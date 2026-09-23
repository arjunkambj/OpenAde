/**
 * Scenario (b): the approval gate, all three answers.
 *
 * Every turn the connector spawns carries `--yolo`, which turns off the CLI's
 * own refusal of writes and shell calls — so the PreToolUse hook is the only
 * thing between a model and the machine, and this is the path that carries it:
 * the CLI runs our generated hook script, the script POSTs to the `HookBridge`
 * on a loopback port with its per-session bearer, the bridge asks the
 * permission ladder, the ladder says "prompt", an approval card appears in the
 * thread the user is looking at, and the answer travels all the way back out
 * to the blocked hook.
 *
 * The three answers are three different claims:
 *
 * - **allow-once** — the call runs and the turn finishes.
 * - **deny** — the call does not run, and the side effect it would have had is
 *   verifiably absent from the workspace.
 * - **allow-always** — a rule is persisted, and the *next identical call does
 *   not ask*. That last half is the one a unit test cannot make: it needs a
 *   second real turn against the same session and the same rule table.
 */

import { makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
  type E2EClient,
  type E2EHome,
} from "./harness";
import { watchThread } from "./watch";

/** The prompts `fixtures/cmd/shell-yolo/` and `shell-deny-yolo/` were recorded on. */
const READ_NOTE =
  "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.";
/** The second turn of `fixtures/cmd/shell-twice/`: the same call, asked again. */
const READ_NOTE_AGAIN =
  "Run the shell command `cat note.txt` again and tell me the output. Use the shell tool.";
const COPY_NOTE =
  "Run the shell command `cp note.txt copied.txt` and tell me what happened. Use the shell tool.";

const SEED = { "note.txt": "hello\n" };

/** Creates the project and thread every case here starts from. */
const openThread = (client: E2EClient, home: E2EHome, projectId: ProjectId, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* client.send(
      command({ type: "project.create", projectId, name: "e2e", workspaceRoot: home.workspace }),
    );
    yield* client.send(
      command({
        type: "thread.create",
        threadId,
        projectId,
        // `approval-required` is the default, and the mode this whole file is
        // about: the ladder prompts rather than deciding for the user.
        settings: { model: E2E_MODEL, runtimeMode: "approval-required" },
      }),
    );
  });

const approvals = (driver: Driver) => {
  it.live("allow-once lets the call run and the turn finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("allow-once", SEED);
        yield* seedSettings(home, [driver.connector(home, "shell-yolo")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        yield* openThread(client, home, projectId, threadId);
        const thread = yield* watchThread(client.rpc, threadId);

        // Anchored on the turn's own receipt: the thread is settled until the
        // turn starts, so a wait that can resolve from history would otherwise
        // answer with that idle view instead of the finished turn.
        const started = yield* thread.markAfter(
          yield* client.send(
            command({
              type: "thread.turn.start",
              threadId,
              text: READ_NOTE,
              attachments: [],
              mentions: [],
              queued: false,
            }),
          ),
        );

        // Either outcome settles the wait, so a turn that never asks fails
        // with what it did instead of timing the suite out.
        const asked = yield* thread.awaitValue(
          (view) => view.pendingApproval !== null || isSettled(view),
          started,
        );
        expect(asked.pendingApproval).not.toBeNull();
        const request = asked.pendingApproval!;
        expect(request.toolName.length).toBeGreaterThan(0);
        // The card has something to show and something to offer as a rule.
        expect(request.description.length).toBeGreaterThan(0);

        const answered = yield* thread.markAfter(
          yield* client.send(
            command({
              type: "thread.approval.respond",
              threadId,
              requestId: request.requestId,
              decision: "allow-once",
            }),
          ),
        );

        const done = yield* thread.awaitValue(isSettled, answered);
        expect(done.pendingApproval).toBeNull();
        // The card is gone, and the timeline keeps a line saying what it was.
        expect(
          done.decisions?.map((decision) => [decision.kind, decision.id, decision.outcome]),
        ).toEqual([["approval", request.requestId, "allow-once"]]);
        expect(done.decisions?.[0]?.subject?.length).toBeGreaterThan(0);

        // The call ran: a command row that completed, and the file it read.
        const shell = done.items.filter((item) => item.kind === "command_execution");
        expect(shell.length).toBeGreaterThan(0);
        expect(shell.at(-1)!.status).toBe("completed");
        expect(shell.at(-1)!.command?.output).toContain("hello");

        // And the model's answer about it is on the timeline. This is the half
        // a connector-level test cannot make: the answer is written either
        // side of the turn's usage frame, and a coalescing window that flushed
        // those two out of order had the client drop the answer — the user saw
        // the command run and then nothing.
        expect(assistantText(done).length).toBeGreaterThan(0);
        const answer = done.items.filter((item) => item.kind === "assistant_message");
        expect(answer.at(-1)!.status).toBe("completed");
      }),
    ),
  );

  it.live("deny stops the call and leaves the side effect undone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("deny", SEED);
        yield* seedSettings(home, [driver.connector(home, "shell-deny-yolo")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        yield* openThread(client, home, projectId, threadId);
        const thread = yield* watchThread(client.rpc, threadId);

        const target = NodePath.join(home.workspace, "copied.txt");
        const started = yield* thread.markAfter(
          yield* client.send(
            command({
              type: "thread.turn.start",
              threadId,
              text: COPY_NOTE,
              attachments: [],
              mentions: [],
              queued: false,
            }),
          ),
        );

        const asked = yield* thread.awaitValue(
          (view) => view.pendingApproval !== null || isSettled(view),
          started,
        );
        expect(asked.pendingApproval).not.toBeNull();

        const answered = yield* thread.markAfter(
          yield* client.send(
            command({
              type: "thread.approval.respond",
              threadId,
              requestId: asked.pendingApproval!.requestId,
              decision: "deny",
            }),
          ),
        );

        const done = yield* thread.awaitValue(isSettled, answered);
        const shell = done.items.filter((item) => item.kind === "command_execution");
        expect(shell.length).toBeGreaterThan(0);
        expect(shell.at(-1)!.status).toBe("failed");

        // The point of the whole gate: the command did not run.
        expect(NodeFS.existsSync(target)).toBe(false);
      }),
    ),
  );

  it.live("allow-always persists a rule, and the next identical call does not ask", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("allow-always", SEED);
        yield* seedSettings(home, [driver.connector(home, "shell-twice")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        yield* openThread(client, home, projectId, threadId);
        const thread = yield* watchThread(client.rpc, threadId);

        const turn = (text: string) =>
          client
            .send(
              command({
                type: "thread.turn.start",
                threadId,
                text,
                attachments: [],
                mentions: [],
                queued: false,
              }),
            )
            .pipe(Effect.flatMap(thread.markAfter));

        const beforeFirst = yield* turn(READ_NOTE);
        const asked = yield* thread.awaitValue(
          (view) => view.pendingApproval !== null || isSettled(view),
          beforeFirst,
        );
        expect(asked.pendingApproval).not.toBeNull();
        const request = asked.pendingApproval!;
        // The card offers a rule to persist; the user may edit it, so the
        // client sends the final text rather than the server re-deriving it.
        expect(request.patternSuggestion).toBeDefined();

        const answered = yield* thread.markAfter(
          yield* client.send(
            command({
              type: "thread.approval.respond",
              threadId,
              requestId: request.requestId,
              decision: "allow-always",
              ...(request.patternSuggestion === undefined
                ? {}
                : { pattern: request.patternSuggestion }),
            }),
          ),
        );
        const first = yield* thread.awaitValue(isSettled, answered);
        const ranOnce = first.items.filter((item) => item.kind === "command_execution").length;
        expect(ranOnce).toBeGreaterThan(0);

        // The rule is on the wire, where the settings page reads it.
        const settings = yield* (yield* client.rpc)["settings.get"]({}).pipe(Effect.orDie);
        const rule = settings.permissions.find((r) => r.pattern === request.patternSuggestion);
        expect(rule).toBeDefined();
        expect(rule!.decision).toBe("allow");

        // The second turn makes the same call. The ladder must answer it from
        // the rule — so no card opens, and the turn runs straight through.
        // Everything below is measured from this mark: the collector resolves a
        // wait from history too, and turn one's card is in that history.
        const beforeSecond = yield* turn(READ_NOTE_AGAIN);
        const second = yield* thread.awaitValue(
          (view) =>
            view.pendingApproval !== null ||
            (isSettled(view) &&
              view.items.filter((item) => item.kind === "command_execution").length > ranOnce),
          beforeSecond,
        );
        expect(second.pendingApproval).toBeNull();

        // And nothing asked at any point during it: a card that opened and
        // closed again would still be a card the user had to answer.
        const during = yield* thread.since(beforeSecond);
        expect(during.filter((view) => view.pendingApproval !== null)).toEqual([]);
      }),
    ),
  );
};

forEachDriver("the approval gate", approvals);
