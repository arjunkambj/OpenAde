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

import { DENIED_BY_RULES, DENIED_BY_USER, makeToolGate } from "./toolGate";

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
const hook = (toolName: string) => ({ hook_event_name: "PreToolUse", tool_name: toolName });

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
      const opened = yield* Effect.sync(() => events.find((e) => e.type === "request.opened")).pipe(
        Effect.flatMap((event) =>
          event === undefined ? Effect.fail("wait") : Effect.succeed(event),
        ),
        Effect.eventually,
      );
      expect(opened.type === "request.opened" && opened.payload.request).toMatchObject({
        kind: "other",
        toolName: "Bash",
        input,
        patternSuggestion: "Bash",
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
});
