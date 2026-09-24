/**
 * The approval gate on Claude Code, through the whole server.
 *
 * Every tool call the CLI makes passes the connector's PreToolUse hook, which
 * asks the server's permission ladder; a "prompt" goes on to the CLI's
 * `canUseTool` and an approval card in the thread. Three claims:
 *
 * - **allow once** (`edit-approval`) — asked before anything is written; the
 *   write runs once allowed, as a file-change row that completes.
 * - **deny** (`deny`) — the command does not run, and the file it would have
 *   made is verifiably absent.
 * - **a sensitive path under full access** (`sensitive-full-access`) — full
 *   access runs the CLI in `bypassPermissions`, and reading `.env` still
 *   opens a card: "ask" outranks allow, whatever the mode.
 *
 * A replay runs no tool, so what a tool did to the workspace is checked by the
 * live and record drivers; a replay checks what the thread shows. Each
 * scenario answers every card the same way, however many the model raises.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";
import type { ApprovalDecision } from "@poseidon/contracts/enums";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assistantText,
  command,
  connect,
  isSettled,
  startTurn,
  staticCredentials,
  type E2EClient,
  type OpenThread,
} from "../e2e/harness";
import type { ViewMark } from "../e2e/watch";
import { claudeScenario } from "./harness";

const CREATE = "Create a file named hello.txt containing exactly the text: hi";
const TOUCH = "Run the shell command `touch denied.txt` with the Bash tool.";
const CAT_ENV = "Run the shell command `cat .env` with the Bash tool and tell me what it prints.";
/** Not a secret: the scratch repo's `.env`, there to be refused. */
const ENV_LINE = "POSEIDON_SCENARIO_KEY=not-a-real-key";

type PendingApproval = NonNullable<ThreadDetailView["pendingApproval"]>;

/**
 * Answers every card the turn started at `from` raises with `decision`, until
 * the thread settles, and answers with the settled view and every card seen.
 * `beforeFirst` runs while the first card is still waiting.
 */
const answerEvery = (
  client: E2EClient,
  open: OpenThread,
  from: ViewMark,
  decision: ApprovalDecision,
  beforeFirst: (request: PendingApproval) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<{ readonly done: ThreadDetailView; readonly asked: Array<PendingApproval> }> =>
  Effect.gen(function* () {
    const asked: Array<PendingApproval> = [];
    const answered = new Set<string>();
    let mark = from;
    for (;;) {
      const { value, next } = yield* open.view.awaitAt(
        (view) =>
          (view.pendingApproval !== null && !answered.has(view.pendingApproval.requestId)) ||
          isSettled(view),
        mark,
      );
      mark = next;
      const request = value.pendingApproval;
      if (request === null || answered.has(request.requestId)) return { done: value, asked };
      if (asked.length === 0) yield* beforeFirst(request);
      asked.push(request);
      answered.add(request.requestId);
      yield* client.send(
        command({
          type: "thread.approval.respond",
          threadId: open.threadId,
          requestId: request.requestId,
          decision,
        }),
      );
    }
  });

claudeScenario(
  "allowing a Claude Code write once",
  {
    scenario: "edit-approval",
    description:
      "Approval-required: the model is asked to create hello.txt; the write stops on an approval card, the card is allowed once, and the write runs.",
    prompts: [CREATE],
  },
  "asks before writing, then writes once allowed",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "approval-required" });
      const target = NodePath.join(run.home.workspace, "hello.txt");

      const started = yield* startTurn(client, open, { text: CREATE });
      const { done, asked } = yield* answerEvery(client, open, started, "allow-once", (request) =>
        Effect.sync(() => {
          expect(request.kind).toBe("file_write");
          expect(request.patternSuggestion).toMatch(/^Edit\(.*hello\.txt\)$/);
          // Nothing is written while the card waits.
          expect(NodeFS.existsSync(target)).toBe(false);
        }),
      );
      expect(asked.length).toBeGreaterThan(0);

      expect(done.status).not.toBe("error");
      expect(done.decisions?.[0]).toMatchObject({
        kind: "approval",
        id: asked[0]!.requestId,
        outcome: "allow-once",
      });
      const writes = done.items.filter(
        (item) => item.kind === "file_change" && item.fileChange?.path.endsWith("hello.txt"),
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[0]!.status).toBe("completed");
      expect(writes[0]!.fileChange?.diff).toContain("+hi");
      // And it completed only once the card had been answered.
      const views = yield* open.view.since(started);
      const answeredAt = views.findIndex((view) => (view.decisions?.length ?? 0) > 0);
      const writtenAt = views.findIndex((view) =>
        view.items.some((item) => item.kind === "file_change" && item.status === "completed"),
      );
      expect(answeredAt).toBeGreaterThanOrEqual(0);
      expect(writtenAt).toBeGreaterThanOrEqual(answeredAt);
      expect(assistantText(done).length).toBeGreaterThan(0);
      if (run.driver !== "replay") {
        expect(NodeFS.readFileSync(target, "utf8").trim()).toBe("hi");
      }
    }),
);

claudeScenario(
  "denying a Claude Code command",
  {
    scenario: "deny",
    description:
      "Approval-required: the model is asked to run `touch denied.txt`; every approval card is denied, the command never runs, and the turn ends on the model's reply.",
    prompts: [TOUCH],
  },
  "stops the command and leaves the file unmade",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "approval-required" });

      const started = yield* startTurn(client, open, { text: TOUCH });
      const { done, asked } = yield* answerEvery(client, open, started, "deny");
      expect(asked[0]).toMatchObject({
        kind: "command",
        toolName: "Bash",
        patternSuggestion: "Shell(touch *)",
      });

      expect(done.decisions?.every((decision) => decision.outcome === "deny")).toBe(true);
      const shell = done.items.filter((item) => item.kind === "command_execution");
      expect(shell.length).toBeGreaterThan(0);
      expect(shell.every((item) => item.status === "failed")).toBe(true);
      // The point of the gate: the command did not run.
      expect(NodeFS.existsSync(NodePath.join(run.home.workspace, "denied.txt"))).toBe(false);
    }),
);

claudeScenario(
  "a sensitive read under full access on Claude Code",
  {
    scenario: "sensitive-full-access",
    description:
      "Full access (the CLI in bypassPermissions): the model is asked to `cat .env`; the permission ladder still says prompt for the sensitive path, so an approval card opens, and it is denied.",
    prompts: [CAT_ENV],
    seed: { ".env": `${ENV_LINE}\n` },
  },
  "still asks before reading .env, and nothing is read once denied",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "full-access" });

      const started = yield* startTurn(client, open, { text: CAT_ENV });
      const { done, asked } = yield* answerEvery(client, open, started, "deny");
      // Full access allows everything else; this card is the sensitive path's.
      expect(asked.length).toBeGreaterThan(0);
      expect(JSON.stringify(asked[0]!.input)).toContain(".env");

      expect(done.decisions?.every((decision) => decision.outcome === "deny")).toBe(true);
      // Nothing on the timeline carries the file's contents.
      expect(JSON.stringify(done.items)).not.toContain("not-a-real-key");
    }),
);
