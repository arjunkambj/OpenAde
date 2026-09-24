/**
 * The timeline fixture's "Conversation" scenario: a thread shaped like a real
 * one, built in code so every row state the timeline draws shows up at once.
 *
 * Four settled turns and one running turn. The first adds an endpoint (reads,
 * searches, a passing command, a create and two edits, interim narration); the
 * second is a long message with two screenshots and a skill and a plugin
 * reference (web search, an in-app browser call, a failing command, an edit
 * given as an absolute path, a delete, a skill, a todo list); the third is a
 * markdown message (a plan and its decision, an allowed and a denied approval,
 * an answered question, a subagent task with nested calls, an error, and a
 * steered second message inside the same turn); the fourth answers with two
 * oversized code blocks, after a compaction and a frame this build does not
 * model. The last turn is still running.
 *
 * Every id is a real UUIDv7 minted from a clock that moves the way a turn
 * does — seconds between tool calls, minutes between turns — because the
 * timeline reads time out of ids: durations, "Worked for", the running clock.
 * The ids are deterministic for a given `now`, so a test can pin them.
 *
 * Checkpoints follow the server: one per settled turn, taken when it
 * completed, except the thread's very first turn, which has none — so a
 * restore to "before the second turn" has nothing to go back to, and the
 * affordances that depend on it can be seen hidden as well as shown.
 */

import { decodeProjectId, decodeThreadId, type TurnId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import {
  change,
  done,
  makeBuilder,
  run,
  say,
  tool,
  turn,
  WORKSPACE_ROOT,
  type Builder,
} from "@/components/dev/timeline-fixture-builder";
import * as text from "@/components/dev/timeline-fixture-text";
import { FIXTURE_IMAGE_PATHS } from "@/lib/fixture-images";

export interface RichTimelineOptions {
  /** When the thread is "now": the running turn started a little before it. Default `Date.now()`. */
  readonly now?: number;
  /** How many times the settled turns repeat — the ×10 / ×50 virtualization check. Default 1. */
  readonly copies?: number;
  /** Whether the thread ends on a running turn. Default true. */
  readonly running?: boolean;
}

/** Room for one copy of the settled turns; each copy starts on the next boundary. */
const COPY_SPAN_MS = 60 * 60_000;

/** How long before `now` the running turn was requested. */
const RUNNING_LEAD_MS = 45_000;

/** A short ask, then reads, a search, a passing run, a create and two edits. */
const healthTurn = (b: Builder, first: boolean): void => {
  const t = turn(b, 0);
  b.add(t, 0, { kind: "user_message", status: done, text: text.SHORT_ASK });
  b.add(t, 3_000, { kind: "reasoning", status: done, text: text.REASONING.health });
  b.add(t, 2_000, say(text.NARRATION.readRouter));
  b.add(
    t,
    1_500,
    tool("read_file", { file_path: "apps/server/src/http/router.ts" }, { lines: 42 }),
  );
  b.add(
    t,
    1_200,
    tool("grep", { pattern: "router.mount", path: "apps/server/src" }, { matches: 2 }),
  );
  b.add(t, 900, tool("glob", { pattern: "apps/server/src/http/*.ts" }, { files: 6 }));
  b.add(t, 8_000, change("apps/server/src/http/health.ts", "create", text.DIFF_HEALTH));
  b.add(t, 4_000, change("apps/server/src/http/router.ts", "edit", text.DIFF_ROUTER));
  b.add(t, 3_000, change("scripts/smoke.sh", "edit", text.DIFF_SMOKE));
  b.add(t, 2_000, say(text.NARRATION.runTests));
  b.add(
    t,
    14_000,
    run("pnpm vitest run apps/server", 0, "Test Files  4 passed (4)\n     Tests  19 passed (19)\n"),
  );
  b.add(t, 9_000, say(text.ANSWER_HEALTH));
  b.settle(t, !first);
};

/** The long message with screenshots: browsing, a failure and its fix, a delete, a todo list. */
const settingsTurn = (b: Builder): void => {
  const t = turn(b, 4 * 60_000);
  b.add(t, 0, {
    kind: "user_message",
    status: done,
    text: text.LONG_ASK,
    attachments: FIXTURE_IMAGE_PATHS.map((path) => ({
      path,
      mime: "image/png",
      name: path.slice(path.lastIndexOf("/") + 1),
    })),
    references: [
      { kind: "skill", name: "review" },
      { kind: "plugin", name: "formatter" },
    ],
  });
  b.add(t, 4_000, { kind: "reasoning", status: done, text: text.REASONING.settings });
  b.add(t, 2_000, {
    kind: "todo",
    status: done,
    todos: [
      { todoId: "1", text: "Banner follows the accent colour", status: "completed" },
      { todoId: "2", text: "Keep the sidebar order when narrow", status: "completed" },
      { todoId: "3", text: "Inline save confirmation", status: "completed" },
      { todoId: "4", text: "Test for the narrow layout", status: "pending" },
    ],
  });
  b.add(t, 3_000, {
    kind: "web_search",
    status: done,
    text: "Looked up inline save confirmation patterns.",
    tool: {
      name: "web_search",
      input: { query: "inline save confirmation pattern" },
      output: { results: 5 },
    },
  });
  b.add(t, 6_000, {
    kind: "mcp_tool_call",
    status: done,
    tool: {
      name: "mcp__openade__browser_open",
      server: "openade",
      input: { url: "http://localhost:5173/settings" },
      output: { title: "Settings" },
    },
  });
  b.add(
    t,
    5_000,
    change(`${WORKSPACE_ROOT}/apps/web/src/settings/banner.tsx`, "edit", text.DIFF_BANNER),
  );
  b.add(t, 3_000, change("apps/web/src/settings/save-modal.tsx", "delete", text.DIFF_SAVE_MODAL));
  b.add(
    t,
    16_000,
    run(
      "pnpm --filter web test -- settings",
      1,
      "FAIL  src/settings/banner.test.tsx > matches the snapshot\n  - banner: '#3b82f6'\n  + banner: 'var(--primary)'\n\nTest Files  1 failed | 11 passed (12)\n",
    ),
  );
  b.add(t, 2_000, say(text.NARRATION.testFailed));
  b.add(t, 5_000, change("apps/web/src/settings/banner.test.tsx", "edit", text.DIFF_BANNER_TEST));
  b.add(t, 12_000, run("pnpm --filter web test -- settings", 0, "Test Files  12 passed (12)\n"));
  b.add(t, 2_000, { ...tool("activate_skill", { name: "review" }), kind: "skill", text: "review" });
  b.add(t, 11_000, say(text.ANSWER_SETTINGS));
  b.settle(t, true);
};

/** The markdown message: a plan, approvals, a question, a subagent, an error, a steer. */
const readinessTurn = (b: Builder): void => {
  const t = turn(b, 6 * 60_000);
  b.add(t, 0, { kind: "user_message", status: done, text: text.MARKDOWN_ASK });
  b.add(t, 3_000, { kind: "reasoning", status: done, text: text.REASONING.readiness });
  b.add(t, 2_000, say(text.NARRATION.planFirst));
  const plan = b.add(t, 6_000, {
    kind: "plan",
    status: done,
    plan: {
      markdown:
        "## Plan\n\n1. Add `ready.ts` that pings the pool with a timeout\n2. Mount it at `/readyz`\n3. Point the deploy script at it\n",
    },
  });
  b.decide({ kind: "plan", id: t, outcome: "accept", subject: "readiness.md", afterItemId: plan });
  const asked = b.add(t, 20_000, say("Which setting should own the timeout?"));
  b.decide({
    kind: "question",
    outcome: "answered",
    subject: "Timeout source",
    afterItemId: asked,
  });
  const task = b.add(t, 8_000, {
    kind: "task",
    status: done,
    text: "Find handlers the router never mounts",
    tool: {
      name: "agent",
      input: { subagent_type: "explore", prompt: "List every handler the router does not mount." },
      output: { summary: "Two handlers are unmounted: version.ts and metrics.ts." },
    },
  });
  b.add(t, 1_500, {
    ...tool("grep", { pattern: "export const", path: "apps/server/src/http" }),
    parentItemId: task,
  });
  b.add(t, 1_200, {
    ...tool("read_file", { file_path: "apps/server/src/http/metrics.ts" }),
    parentItemId: task,
  });
  b.add(t, 4_000, change("apps/server/src/http/ready.ts", "create", text.DIFF_READY));
  const beforeRun = b.add(t, 2_000, say("Checking the new route against a local database."));
  b.decide({
    kind: "approval",
    outcome: "allow-once",
    subject: "pnpm db:up",
    afterItemId: beforeRun,
  });
  const dbUp = b.add(t, 9_000, run("pnpm db:up", 0, "database ready on :5432\n"));
  b.decide({
    kind: "approval",
    outcome: "deny",
    subject: "rm -rf apps/server/dist",
    afterItemId: dbUp,
  });
  b.add(t, 2_000, {
    kind: "command_execution",
    status: "failed",
    command: {
      cmd: "rm -rf apps/server/dist",
      cwd: WORKSPACE_ROOT,
      output: "The user denied this command.",
    },
  });
  b.add(t, 3_000, {
    kind: "error",
    status: "failed",
    error: { message: "The model request failed: 529 overloaded. Retried after 4s." },
  });
  b.add(t, 25_000, { kind: "user_message", status: done, text: text.STEER_ASK });
  b.add(t, 5_000, change("apps/server/src/http/ready.ts", "edit", text.DIFF_READY_TIMEOUT));
  b.add(t, 8_000, run("pnpm vitest run apps/server -t readyz", 0, "Tests  3 passed (3)\n"));
  b.add(t, 7_000, say(text.ANSWER_READINESS));
  b.settle(t, true);
};

/** Oversized answers, after a compaction and a frame the renderer does not model. */
const largeTurn = (b: Builder): void => {
  const t = turn(b, 3 * 60_000);
  b.add(t, 0, { kind: "user_message", status: done, text: text.LARGE_ASK });
  b.add(t, 2_000, {
    kind: "context_compaction",
    status: done,
    text: "Compacted 120k tokens of history into a summary.",
  });
  b.add(t, 1_000, {
    kind: "unknown",
    status: done,
    text: "A frame this build does not model yet.",
  });
  b.add(t, 2_000, tool("read_file", { file_path: "apps/server/src/http/routes.gen.ts" }));
  b.add(t, 30_000, say(text.ANSWER_LARGE));
  b.settle(t, true);
};

/** The turn still running at `now`: some work done, a command in flight. */
const runningTurn = (b: Builder): TurnId => {
  const t = turn(b, 0);
  b.add(t, 0, { kind: "user_message", status: done, text: text.RUNNING_ASK });
  b.add(t, 3_000, { kind: "reasoning", status: done, text: text.REASONING.running });
  b.add(t, 2_000, {
    kind: "todo",
    status: "in_progress",
    todos: [
      { todoId: "1", text: "Read the deploy script", status: "completed" },
      { todoId: "2", text: "Wait on /readyz after migrating", status: "in_progress" },
      { todoId: "3", text: "Dry-run against staging", status: "pending" },
    ],
  });
  b.add(t, 2_000, say(text.NARRATION.running));
  b.add(t, 1_500, tool("read_file", { file_path: "scripts/deploy.sh" }, { lines: 64 }));
  b.add(t, 6_000, change("scripts/deploy.sh", "edit", text.DIFF_DEPLOY));
  b.add(t, 4_000, {
    kind: "command_execution",
    status: "in_progress",
    command: { cmd: "./scripts/deploy.sh --dry-run staging", cwd: WORKSPACE_ROOT },
  });
  return t;
};

/**
 * The rich thread: `copies` × the four settled turns, then (by default) one
 * running turn. Decodes as a `ThreadDetailSnapshot`.
 */
export const buildRichTimelineSnapshot = (
  options: RichTimelineOptions = {},
): ThreadDetailSnapshot => {
  const now = options.now ?? Date.now();
  const copies = Math.max(1, Math.floor(options.copies ?? 1));
  const running = options.running ?? true;
  const start = now - copies * COPY_SPAN_MS - 2 * RUNNING_LEAD_MS;
  const b = makeBuilder(start);
  const projectId = decodeProjectId(b.mint(0));

  for (let copy = 0; copy < copies; copy += 1) {
    b.jumpTo(start + copy * COPY_SPAN_MS);
    healthTurn(b, copy === 0);
    settingsTurn(b);
    readinessTurn(b);
    largeTurn(b);
  }
  let currentTurnId: TurnId | null = null;
  if (running) {
    b.jumpTo(now - RUNNING_LEAD_MS);
    currentTurnId = runningTurn(b);
  }

  const createdAt = new Date(start).toISOString();
  return {
    threadId: decodeThreadId(b.threadId),
    projectId,
    title: "Health and readiness endpoints",
    status: running ? "running" : "idle",
    settings: {
      model: "fixture/mid",
      effort: "medium",
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
    },
    snapshotSequence: b.items.length,
    items: b.items,
    queue: [],
    checkpoints: b.checkpoints,
    restoring: null,
    session: null,
    currentTurnId,
    pendingApproval: null,
    pendingUserInput: null,
    pendingPlan: null,
    decisions: b.decisions,
    usage: { input: 48_200, output: 6_100, cacheRead: 40_000, cacheWrite: 8_200, costUsd: 0.31 },
    context: { used: 61_400, limit: 200_000 },
    createdAt,
    updatedAt: b.iso(),
  };
};
