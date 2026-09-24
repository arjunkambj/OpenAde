import { makeThreadId } from "@poseidon/contracts/ids";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import type { ConnectorServices, PermissionDecision } from "@poseidon/connector-sdk/definition";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeHookAnswerer } from "./hookAnswers";
import type { PendingRuntimeEvent } from "./items";

/** A hook answerer whose permission engine always says `decision`. */
const answererSaying = (decision: PermissionDecision) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<PendingRuntimeEvent>>([]);
    const asked = yield* Ref.make<ReadonlyArray<ApprovalRequest>>([]);
    // Only `permissions` is reached on this path.
    const services = {
      permissions: {
        decide: (input: { readonly request: ApprovalRequest }) =>
          Ref.update(asked, (all) => [...all, input.request]).pipe(Effect.as(decision)),
      },
    } as unknown as ConnectorServices;
    const answerer = yield* makeHookAnswerer({
      threadId: makeThreadId(),
      services,
      settings: Effect.succeed({
        model: "m",
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
      emit: (event) => Ref.update(events, (all) => [...all, event]),
    });
    return { answerer, events: Ref.get(events), asked: Ref.get(asked) };
  });

const post = (toolName: string, toolInput: unknown) => ({
  hook_event_name: "PreToolUse",
  tool_use_id: "hook-1",
  tool_name: toolName,
  tool_input: toolInput,
});

describe("makeHookAnswerer", () => {
  it.effect("answers from the rules without opening a card", () =>
    Effect.gen(function* () {
      const allowing = yield* answererSaying("allow");
      expect(yield* allowing.answerer.onHookPost(post("shell_command", { command: "ls" }))).toEqual(
        { hookSpecificOutput: { permissionDecision: "allow" } },
      );
      expect(yield* allowing.events).toEqual([]);

      const denying = yield* answererSaying("deny");
      expect(yield* denying.answerer.onHookPost(post("shell_command", { command: "ls" }))).toEqual({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "denied by Poseidon permission rules",
        },
      });
      expect(yield* allowing.answerer.postCount).toBe(1);
    }),
  );

  it.effect("names the MCP server and tool, and suggests an Mcp(...) rule", () =>
    Effect.gen(function* () {
      const { answerer, asked } = yield* answererSaying("allow");
      yield* answerer.onHookPost(post("mcp__github__create_issue", { title: "x" }));
      yield* answerer.onHookPost(post("shell_command", { command: "ls" }));
      const [mcp, shell] = yield* asked;
      expect(mcp).toMatchObject({
        kind: "mcp_tool",
        toolName: "mcp__github__create_issue",
        mcpTool: { server: "github", tool: "create_issue" },
        patternSuggestion: "Mcp(github.create_issue)",
      });
      expect(shell).not.toHaveProperty("mcpTool");
    }),
  );

  it.effect("parks a prompt until the user answers, and a dead process denies it", () =>
    Effect.gen(function* () {
      const { answerer, events } = yield* answererSaying("prompt");
      const answered = yield* Effect.forkChild(
        answerer.onHookPost(post("write_file", { path: "/src/a.ts" })),
      );
      const opened = yield* events.pipe(
        Effect.flatMap((all) => (all.length > 0 ? Effect.succeed(all[0]!) : Effect.fail("wait"))),
        Effect.eventually,
      );
      expect(opened.type).toBe("request.opened");
      const requestId = opened.type === "request.opened" ? opened.payload.request.requestId : null;
      yield* answerer.respondToRequest(requestId!, "allow-session");
      expect(yield* Fiber.join(answered)).toEqual({
        hookSpecificOutput: {
          permissionDecision: "allow",
          permissionDecisionReason: "decided allow-session via Poseidon",
        },
      });

      const parked = yield* Effect.forkChild(
        answerer.onHookPost(post("shell_command", { command: "rm -rf /" })),
      );
      yield* events.pipe(
        Effect.flatMap((all) => (all.length > 2 ? Effect.void : Effect.fail("wait"))),
        Effect.eventually,
      );
      yield* answerer.releasePending;
      expect(yield* Fiber.join(parked)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect((yield* events).map((event) => event.type)).toEqual([
        "request.opened",
        "request.resolved",
        "request.opened",
        "request.resolved",
      ]);
    }),
  );
});
