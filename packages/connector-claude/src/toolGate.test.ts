/**
 * The tool gate's own logic: how the ladder's verdict reads to the CLI, and
 * that every path which cannot reach a verdict closes rather than opens. The
 * ladder here answers one fixed verdict; the real ladder is the server's.
 */

import { makeApprovalGate, type ApprovalGateEvent } from "@OpenAde/connector-sdk/approvalGate";
import type { ConnectorPermissions, PermissionDecision } from "@OpenAde/connector-sdk/definition";
import { makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

import { DENIED_BY_RULES, DENIED_BY_USER, makeToolGate, sessionPermissions } from "./toolGate";

const threadId = makeThreadId();

const ladder = (decide: ConnectorPermissions["decide"]) =>
  Effect.gen(function* () {
    const permissions: ConnectorPermissions = { decide };
    const events: Array<ApprovalGateEvent> = [];
    const gate = yield* makeApprovalGate({
      permissions,
      emit: (event) => Effect.sync(() => void events.push(event)),
    });
    let settings: ThreadSettings = {
      model: "default",
      runtimeMode: "approval-required",
      interactionMode: "default",
    };
    const toolGate = makeToolGate({
      threadId,
      permissions,
      gate,
      settings: () => settings,
      run: Effect.runPromise,
    });
    return {
      gate,
      toolGate,
      events,
      setSettings: (next: ThreadSettings) => {
        settings = next;
      },
    };
  });

const saying = (decision: PermissionDecision) => () => Effect.succeed(decision);
const signal = () => new AbortController().signal;
const hook = (toolName: string, toolInput: unknown = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: toolInput,
});

/** Waits for the gate's first `request.opened`. */
const firstOpened = (events: ReadonlyArray<ApprovalGateEvent>) =>
  Effect.sync(() => events.find((event) => event.type === "request.opened")).pipe(
    Effect.flatMap((event) =>
      event?.type === "request.opened" ? Effect.succeed(event) : Effect.fail("wait"),
    ),
    Effect.eventually,
  );

describe("the PreToolUse hook", () => {
  it.effect.each([
    ["allow", "allow"],
    ["deny", "deny"],
    ["prompt", "ask"],
  ] as const)("answers the ladder's %s as %s", ([verdict, answer]) =>
    Effect.gen(function* () {
      const { toolGate } = yield* ladder(saying(verdict));
      const output = yield* Effect.promise(() => toolGate.preToolUse(hook("Bash")));
      expect(output.hookSpecificOutput?.permissionDecision).toBe(answer);
      expect(output.hookSpecificOutput?.permissionDecisionReason).toBe(
        verdict === "deny" ? DENIED_BY_RULES : undefined,
      );
    }),
  );

  it.effect("asks the ladder with the thread's modes as they are at the call", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const { toolGate, setSettings } = yield* ladder((input) =>
        Effect.sync(() => {
          seen.push(`${input.request.toolName}:${input.runtimeMode}:${input.interactionMode}`);
          return "allow" as const;
        }),
      );
      yield* Effect.promise(() => toolGate.preToolUse(hook("Edit")));
      setSettings({ model: "default", runtimeMode: "full-access", interactionMode: "plan" });
      yield* Effect.promise(() => toolGate.preToolUse(hook("Edit")));
      expect(seen).toEqual(["Edit:approval-required:default", "Edit:full-access:plan"]);
    }),
  );

  it.effect("asks the ladder in OpenAde's vocabulary, not the CLI's", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const { toolGate } = yield* ladder((input) =>
        Effect.sync(() => {
          seen.push(input.request);
          return "allow" as const;
        }),
      );
      yield* Effect.promise(() =>
        toolGate.preToolUse(hook("NotebookEdit", { notebook_path: "/r/.ssh/n.ipynb" })),
      );
      expect(seen[0]).toMatchObject({
        kind: "file_write",
        toolName: "NotebookEdit",
        input: { file_path: "/r/.ssh/n.ipynb" },
        patternSuggestion: "Edit(/r/.ssh/n.ipynb)",
      });
    }),
  );

  it.effect.each(["AskUserQuestion", "ExitPlanMode"])(
    "lets %s past with no verdict, and never asks the ladder",
    (tool) =>
      Effect.gen(function* () {
        const { toolGate } = yield* ladder(() => Effect.die(new Error("asked")));
        expect(yield* Effect.promise(() => toolGate.preToolUse(hook(tool)))).toEqual({});
        expect(toolGate.sightings()).toBe(1);
      }),
  );

  it.effect("counts every call it sees", () =>
    Effect.gen(function* () {
      const { toolGate } = yield* ladder(saying("allow"));
      yield* Effect.promise(() => toolGate.preToolUse(hook("Bash")));
      yield* Effect.promise(() => toolGate.preToolUse({ hook_event_name: "PostToolUse" }));
      yield* Effect.promise(() => toolGate.canUseTool("Bash", {}, { signal: signal() }));
      expect(toolGate.sightings()).toBe(2);
    }),
  );

  it.effect("asks rather than allows when the ladder fails", () =>
    Effect.gen(function* () {
      const { toolGate } = yield* ladder(() => Effect.die(new Error("ladder broke")));
      const output = yield* Effect.promise(() => toolGate.preToolUse(hook("Bash")));
      expect(output.hookSpecificOutput?.permissionDecision).toBe("ask");
    }),
  );

  it.effect("leaves other hook events alone", () =>
    Effect.gen(function* () {
      const { toolGate } = yield* ladder(saying("deny"));
      expect(
        yield* Effect.promise(() => toolGate.preToolUse({ hook_event_name: "PostToolUse" })),
      ).toEqual({});
    }),
  );
});

describe("canUseTool", () => {
  it.effect("opens a card on prompt and allows with the input on the user's allow", () =>
    Effect.gen(function* () {
      const { toolGate, gate, events } = yield* ladder(saying("prompt"));
      const input = { command: "ls" };
      const answer = toolGate.canUseTool("Bash", input, { signal: signal() });
      const opened = yield* firstOpened(events);
      expect(opened.payload.request).toMatchObject({
        kind: "command",
        toolName: "Bash",
        input,
        patternSuggestion: "Shell(ls *)",
        description: "Run ls",
      });
      yield* gate.respond(opened.requestId, "allow-once");
      expect(yield* Effect.promise(() => answer)).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }),
  );

  it.effect("tells the model the user refused when the card is denied", () =>
    Effect.gen(function* () {
      const { toolGate, gate, events } = yield* ladder(saying("prompt"));
      const answer = toolGate.canUseTool("Write", {}, { signal: signal() });
      yield* Effect.sync(() => events.length).pipe(
        Effect.flatMap((count) => (count === 0 ? Effect.fail("wait") : Effect.void)),
        Effect.eventually,
      );
      yield* gate.releaseAll("deny");
      expect(yield* Effect.promise(() => answer)).toEqual({
        behavior: "deny",
        message: DENIED_BY_USER,
      });
    }),
  );

  it.effect("denies without a card when the rules deny", () =>
    Effect.gen(function* () {
      const { toolGate, events } = yield* ladder(saying("deny"));
      expect(
        yield* Effect.promise(() => toolGate.canUseTool("Bash", {}, { signal: signal() })),
      ).toEqual({ behavior: "deny", message: DENIED_BY_RULES });
      expect(events).toEqual([]);
    }),
  );

  it.effect("denies a call the CLI already gave up on", () =>
    Effect.gen(function* () {
      const { toolGate, events } = yield* ladder(saying("allow"));
      const aborted = new AbortController();
      aborted.abort();
      expect(
        yield* Effect.promise(() => toolGate.canUseTool("Bash", {}, { signal: aborted.signal })),
      ).toEqual({ behavior: "deny", message: DENIED_BY_USER });
      expect(events).toEqual([]);
    }),
  );
  it.effect.each(["allow-once", "allow-always"] as const)(
    "answers %s with the input alone, writing no CLI rule",
    (decision) =>
      Effect.gen(function* () {
        const { toolGate, gate, events } = yield* ladder(saying("prompt"));
        const input = { file_path: "/r/a.ts" };
        const answer = toolGate.canUseTool("Write", input, {
          signal: signal(),
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Write" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
        });
        yield* gate.respond((yield* firstOpened(events)).requestId, decision);
        expect(yield* Effect.promise(() => answer)).toEqual({
          behavior: "allow",
          updatedInput: input,
        });
      }),
  );

  it.effect("answers allow-session with the CLI's own rules, kept to the session", () =>
    Effect.gen(function* () {
      const { toolGate, gate, events } = yield* ladder(saying("prompt"));
      const input = { command: "npm test" };
      const answer = toolGate.canUseTool("Bash", input, {
        signal: signal(),
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      });
      yield* gate.respond((yield* firstOpened(events)).requestId, "allow-session");
      expect(yield* Effect.promise(() => answer)).toEqual({
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      });
    }),
  );

  it.effect("answers deny and closes the card when the CLI withdraws the call", () =>
    Effect.gen(function* () {
      const { toolGate, events } = yield* ladder(saying("prompt"));
      const abort = new AbortController();
      const answer = toolGate.canUseTool("Bash", { command: "ls" }, { signal: abort.signal });
      const opened = yield* firstOpened(events);
      abort.abort();
      expect(yield* Effect.promise(() => answer)).toEqual({
        behavior: "deny",
        message: DENIED_BY_USER,
      });
      expect(events.map((event) => [event.type, event.requestId])).toEqual([
        ["request.opened", opened.requestId],
        ["request.resolved", opened.requestId],
      ]);
    }),
  );
});

describe("sessionPermissions", () => {
  it("keeps rules and directories, at the session only, and drops mode changes and denials", () => {
    const suggestions: Array<PermissionUpdate> = [
      {
        type: "addRules",
        rules: [{ toolName: "Read" }],
        behavior: "allow",
        destination: "userSettings",
      },
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
      { type: "addDirectories", directories: ["/tmp/x"], destination: "projectSettings" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      {
        type: "removeRules",
        rules: [{ toolName: "Read" }],
        behavior: "allow",
        destination: "session",
      },
    ];
    expect(sessionPermissions(suggestions)).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Read" }],
        behavior: "allow",
        destination: "session",
      },
      { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
    ]);
    expect(sessionPermissions(undefined)).toEqual([]);
  });
});
