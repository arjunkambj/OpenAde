/**
 * The session end to end: `makeCmdSession` against a real spawned process — a
 * generated `cmd` stand-in (a node script) that emits NDJSON frames, writes its
 * transcript where the harness would, and answers to signals the way the real
 * CLI does (SIGINT → exit 130).
 *
 * The child gets a redirected `HOME` (through the allowlist, the way extraEnv
 * flows) so its transcript lands in a temp `~/.commandcode`, and the session is
 * told the same home so the tailer reads that file. Nothing in the test touches
 * the real `~/.commandcode` or `~/.openade`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeConnectorInstanceId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ConnectorServices, PermissionDecision } from "@OpenAde/connector-sdk/definition";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { makeCmdSession, type CmdSessionRef } from "./session";
import { transcriptPathFor } from "./transcript";

const SESSION_ID = "00000000-0000-7000-8000-fakec0de0001";

/**
 * The fake `cmd`: emits the frame sequence of a successful turn and appends the
 * assistant message to the transcript mid-run — the overlap the translator
 * dedupes. `FAKE_CMD_SLEEP` makes it block instead of exiting, for the
 * interrupt test.
 */
const FAKE_CMD = `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const sessionId = process.env.OPENADE_FAKE_SESSION_ID;
const home = process.env.HOME;
const cwd = process.cwd();
const slug = cwd.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
const dir = path.join(home, ".commandcode", "projects", slug);
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sessionId + ".jsonl");
const emit = (event) =>
  process.stdout.write(JSON.stringify({ type: "event", event }) + "\\n");
fs.writeFileSync(
  transcript,
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\\n",
);
process.on("SIGINT", () => process.exit(130));
emit({ type: "run_start", sessionId });
emit({ type: "turn_start", turnNumber: 1 });
emit({ type: "message_start" });
emit({ type: "model_request_start", model: "fake/model" });
const userMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
  meta: { source: "user", createdAt: 1, messageId: "u-1" },
};
const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello from fake cmd" }],
  meta: { source: "model", createdAt: 2, messageId: "a-1" },
};
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: "message", id: "l1", parentId: null, timestamp: "t", message: assistantMessage, model: "fake/model" }) + "\\n",
);
if (process.env.OPENADE_FAKE_PLAN === "1") {
  // What --permission-mode plan leaves behind (spec 5.6): a markdown file
  // plus a plans-index.json entry keyed by file name and matched by sessionId.
  const plansDir = path.join(home, ".commandcode", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = "openade-plan.md";
  fs.writeFileSync(path.join(plansDir, planFile), "# The plan\\n\\n1. do the thing\\n");
  fs.writeFileSync(
    path.join(plansDir, "plans-index.json"),
    JSON.stringify({
      version: 1,
      plans: {
        "someone-elses.md": { title: "other", sessionId: "other-session", cwd, status: "done", createdAt: 1, updatedAt: 9 },
        [planFile]: { title: "The plan", sessionId, cwd, status: "done", createdAt: 2, updatedAt: 2 },
      },
    }) + "\\n",
  );
}
if (process.env.OPENADE_FAKE_SLEEP === "1") {
  setInterval(() => {}, 1000);
} else if (process.env.OPENADE_FAKE_UNTERMINATED === "1") {
  // The run_end frame with no trailing newline: it can only arrive through
  // the splitter's EOF flush.
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      sessionId,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      finalText: "hello from fake cmd",
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "event",
      event: {
        type: "run_end",
        result: {
          finalText: "hello from fake cmd",
          stopReason: "end_turn",
          turnCount: 1,
          usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          nextState: { sessionId, messages: [userMessage, assistantMessage], interrupted: false },
        },
      },
    }),
  );
  process.exit(0);
} else {
  emit({
    type: "run_end",
    result: {
      finalText: "hello from fake cmd",
      stopReason: "end_turn",
      turnCount: 1,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      nextState: { sessionId, messages: [userMessage, assistantMessage], interrupted: false },
    },
  });
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      sessionId,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      finalText: "hello from fake cmd",
    }) + "\\n",
  );
  process.exit(0);
}
`;

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly openadeHome: string;
  readonly binary: string;
}

const fixture = (): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Fixture => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-session-test-"));
      const home = NodePath.join(root, "home");
      const openadeHome = NodePath.join(root, "openade");
      NodeFS.mkdirSync(NodePath.join(root, "workspace"), { recursive: true });
      NodeFS.mkdirSync(home, { recursive: true });
      const binary = NodePath.join(root, "fake-cmd.mjs");
      NodeFS.writeFileSync(binary, FAKE_CMD, { mode: 0o755 });
      return { root, home, openadeHome, binary };
    }),
    (f) =>
      Effect.sync(() => {
        NodeFS.rmSync(f.root, { recursive: true, force: true });
        if (previousOpenadeHome === undefined) {
          delete process.env.OPENADE_HOME;
        } else {
          process.env.OPENADE_HOME = previousOpenadeHome;
        }
        previousOpenadeHome = undefined;
      }),
  );

// ensureHookScript reads process.env.OPENADE_HOME; each fixture redirects it
// and the release above puts the previous value back.
let previousOpenadeHome: string | undefined;

const withOpenadeHome = (f: Fixture): void => {
  previousOpenadeHome = process.env.OPENADE_HOME;
  process.env.OPENADE_HOME = f.openadeHome;
};

const services = (
  decide: PermissionDecision,
  registered?: Ref.Ref<((body: unknown) => Effect.Effect<unknown>) | null>,
): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.succeed<ConnectorServices>({
      mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
      hookEndpoint: () =>
        Effect.succeed({ url: "http://127.0.0.1:9/hooks/pretooluse", bearer: "t" }),
      ...(registered === undefined
        ? {}
        : {
            registerHookHandler: (_threadId, handler) => Ref.set(registered, handler),
            unregisterHookHandler: (_threadId) => Ref.set(registered, null),
          }),
      permissions: { decide: () => Effect.succeed(decide) },
      attachmentsDir: "/tmp/openade-attachments",
      logger: { log: () => Effect.void },
      clock,
    }),
  );

const startSession = (
  f: Fixture,
  decide: PermissionDecision,
  registered?: Ref.Ref<((body: unknown) => Effect.Effect<unknown>) | null>,
  extraEnv: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const handle = yield* makeCmdSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: NodePath.join(f.root, "workspace"),
      binaryPath: f.binary,
      extraEnv: {
        HOME: f.home,
        OPENADE_FAKE_SESSION_ID: SESSION_ID,
        ...extraEnv,
      },
      home: f.home,
      services: yield* services(decide, registered),
      settings: {
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    const collector = yield* makeStreamCollector(handle.events);
    return { handle, collector };
  });

const isType =
  (type: string) =>
  (event: { type: string }): boolean =>
    event.type === type;

describe("makeCmdSession against a real spawned process", () => {
  it.effect("runs a turn: frames plus transcript dedupe into one event stream", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      const { handle, collector } = yield* startSession(f, "allow");

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      const completed = yield* collector.awaitItem(isType("turn.completed"));

      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe("end_turn");
      const events = yield* collector.collected;
      const typeList = events.map((event) => event.type);
      expect(typeList[0]).toBe("session.started");
      expect(typeList).toContain("turn.started");
      expect(typeList).toContain("model.changed");
      expect(typeList).toContain("usage.updated");

      // The assistant text arrived twice — transcript append and nextState —
      // and produced exactly one item.
      const assistant = events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.item.kind === "assistant_message",
      );
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.type === "item.completed" && assistant[0].payload.item.text).toBe(
        "hello from fake cmd",
      );

      // The sessionRef the engine persists points at the redirected transcript.
      const started = events.find(isType("session.started"));
      const ref =
        started?.type === "session.started" ? (started.payload.sessionRef as CmdSessionRef) : null;
      expect(ref?.sessionId).toBe(SESSION_ID);
      expect(ref?.cwd).toBe(NodePath.join(f.root, "workspace"));
      expect(ref?.transcriptPath).toBe(
        transcriptPathFor(
          NodeFS.realpathSync(NodePath.join(f.root, "workspace")),
          SESSION_ID,
          f.home,
        ),
      );
      expect(NodeFS.existsSync(ref!.transcriptPath)).toBe(true);

      const persisted = (yield* handle.sessionRef()) as CmdSessionRef | null;
      expect(persisted?.sessionId).toBe(SESSION_ID);

      // A second turn spawns a fresh process resuming the same session.
      yield* handle.send({ text: "again", attachments: [], mentions: [] });
      yield* collector.awaitItem(
        (event) => event.type === "turn.completed" && event.eventId !== completed.eventId,
      );
      const after = yield* collector.collected;
      expect(after.filter(isType("session.started"))).toHaveLength(1);
      expect(after.filter(isType("turn.completed"))).toHaveLength(2);

      yield* handle.close();
      yield* collector.awaitDone;
      expect((yield* collector.collected).at(-1)?.type).toBe("session.ended");
    }),
  );

  it.effect("interrupt signals the process and settles the turn interrupted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      // The sleeping variant of the fake never finishes on its own.
      const { handle, collector } = yield* Effect.gen(function* () {
        const handle = yield* makeCmdSession({
          instanceId: makeConnectorInstanceId(),
          threadId: makeThreadId(),
          workspaceRoot: NodePath.join(f.root, "workspace"),
          binaryPath: f.binary,
          extraEnv: {
            HOME: f.home,
            OPENADE_FAKE_SESSION_ID: SESSION_ID,
            OPENADE_FAKE_SLEEP: "1",
          },
          home: f.home,
          services: yield* services("allow"),
          settings: {
            model: "fake/model",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        });
        const collector = yield* makeStreamCollector(handle.events);
        return { handle, collector };
      });
      yield* handle.send({ text: "block", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("turn.started"));
      yield* handle.interrupt();
      const completed = yield* collector.awaitItem(isType("turn.completed"));
      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe(
        "interrupted",
      );
      yield* handle.close();
    }),
  );

  it.effect("routes a hook post through permissions and resolves prompts", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      const registered = yield* Ref.make<((body: unknown) => Effect.Effect<unknown>) | null>(null);
      // The sleeping fake keeps the process alive while hook posts are in
      // flight — otherwise a finished child releases the parked request with
      // an empty answer before respondToUserInput can land.
      const { handle, collector } = yield* startSession(f, "prompt", registered, {
        OPENADE_FAKE_SLEEP: "1",
      });

      // Registration happens at session start, before any turn.
      const handler = yield* Ref.get(registered);
      expect(handler).not.toBeNull();

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("session.started"));

      const hookBody = {
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_use_id: "hook-1",
        tool_name: "shell_command",
        tool_input: { command: "rm -rf build" },
        cwd: NodePath.join(f.root, "workspace"),
      };
      const answer = yield* Effect.forkChild(handler!(hookBody));
      const opened = yield* collector.awaitItem(isType("request.opened"));
      const requestId = opened.type === "request.opened" ? opened.payload.request.requestId : null;
      expect(requestId).not.toBeNull();
      yield* handle.respondToRequest(requestId!, "allow-once");
      const response = (yield* Fiber.join(answer)) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
      yield* collector.awaitItem(isType("request.resolved"));

      // ask_user_question goes through user-input, answered deny + answers.
      const question = yield* Effect.forkChild(
        handler!({
          ...hookBody,
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                questionId: "q1",
                question: "which?",
                options: [{ optionId: "a", label: "A" }],
              },
            ],
          },
        }),
      );
      const asked = yield* collector.awaitItem(isType("user-input.requested"));
      const askedId = asked.type === "user-input.requested" ? asked.payload.requestId : null;
      yield* handle.respondToUserInput(askedId!, [{ questionId: "q1", optionIds: ["a"] }]);
      const questionResponse = (yield* Fiber.join(question)) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(questionResponse.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(questionResponse.hookSpecificOutput.permissionDecisionReason).toContain('"q1"');

      yield* handle.close();
    }),
  );

  it.effect("the unterminated final frame still lands via the splitter's EOF flush", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          OPENADE_FAKE_SESSION_ID: SESSION_ID,
          OPENADE_FAKE_UNTERMINATED: "1",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "fake/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      // usage.updated and the assistant item only exist if the unterminated
      // run_end tail was parsed — the terminated frames ended at `result`,
      // which is where turn.completed comes from here.
      yield* collector.awaitItem(isType("turn.completed"));
      yield* collector.awaitItem(isType("usage.updated"));
      yield* collector.awaitItem(
        (event) =>
          event.type === "item.completed" && event.payload.item.kind === "assistant_message",
      );

      yield* handle.close();
    }),
  );

  it.effect("a plan-mode turn proposes the plan file before completing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          OPENADE_FAKE_SESSION_ID: SESSION_ID,
          OPENADE_FAKE_PLAN: "1",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "fake/model",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "plan it", attachments: [], mentions: [] });
      const proposed = yield* collector.awaitItem(isType("turn.plan.proposed"));
      expect(proposed.type === "turn.plan.proposed" && proposed.payload.planMarkdown).toContain(
        "# The plan",
      );
      // Matched by sessionId: the other session's index entry is ignored, and
      // the path lands under the fake's own ~/.commandcode/plans.
      expect(proposed.type === "turn.plan.proposed" && proposed.payload.planPath).toBe(
        NodePath.join(f.home, ".commandcode", "plans", "openade-plan.md"),
      );

      // The proposal precedes turn.completed, and a second turn in the same
      // mode does not re-propose the same file.
      const completed = yield* collector.awaitItem(isType("turn.completed"));
      const first = yield* collector.collected;
      expect(first.indexOf(proposed)).toBeLessThan(first.indexOf(completed));

      yield* handle.send({ text: "replan", attachments: [], mentions: [] });
      yield* collector.awaitItem(
        (event) => event.type === "turn.completed" && event.eventId !== completed.eventId,
      );
      const all = yield* collector.collected;
      expect(all.filter(isType("turn.plan.proposed"))).toHaveLength(1);

      yield* handle.close();
    }),
  );

  it.effect("an allow decision answers the hook without opening a request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withOpenadeHome(f);
      const registered = yield* Ref.make<((body: unknown) => Effect.Effect<unknown>) | null>(null);
      const { handle } = yield* startSession(f, "allow", registered);
      const handler = (yield* Ref.get(registered))!;
      const response = (yield* handler({
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_name: "edit_file",
        tool_input: { file_path: "a.ts" },
      })) as { hookSpecificOutput: { permissionDecision: string } };
      expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
      yield* handle.close();
    }),
  );
});
