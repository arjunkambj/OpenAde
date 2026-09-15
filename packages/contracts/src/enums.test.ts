import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalDecision,
  ApprovalKind,
  DEFAULT_RUNTIME_MODE,
  Effort,
  InteractionMode,
  ItemKind,
  RuntimeMode,
} from "./enums";

describe("closed vocabularies", () => {
  it.effect("carry exactly the members the spec lists", () =>
    Effect.gen(function* () {
      const literals = yield* Effect.succeed({
        runtimeMode: RuntimeMode.literals,
        interactionMode: InteractionMode.literals,
        effort: Effort.literals,
        approvalKind: ApprovalKind.literals,
        approvalDecision: ApprovalDecision.literals,
      });
      expect(literals.runtimeMode).toEqual([
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ]);
      expect(literals.interactionMode).toEqual(["default", "plan"]);
      expect(literals.effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(literals.approvalKind).toEqual([
        "command",
        "file_write",
        "file_read",
        "mcp_tool",
        "web",
        "other",
      ]);
      expect(literals.approvalDecision).toEqual([
        "allow-once",
        "allow-session",
        "allow-always",
        "deny",
      ]);
    }),
  );

  it.effect("give the timeline one ItemKind per row component", () =>
    Effect.gen(function* () {
      const kinds = yield* Effect.succeed(ItemKind.literals);
      expect(kinds).toEqual([
        "user_message",
        "assistant_message",
        "reasoning",
        "plan",
        "command_execution",
        "file_change",
        "tool_call",
        "mcp_tool_call",
        "web_search",
        "task",
        "todo",
        "skill",
        "context_compaction",
        "error",
        "unknown",
      ]);
    }),
  );

  it.effect("reject a member that is not in the union", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() => Schema.decodeUnknownExit(RuntimeMode)("yolo"));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("DEFAULT_RUNTIME_MODE", () => {
  it.effect("asks before acting", () =>
    Effect.gen(function* () {
      const mode = yield* Effect.succeed(DEFAULT_RUNTIME_MODE);
      expect(mode).toBe("approval-required");
      expect(Schema.decodeUnknownSync(RuntimeMode)(mode)).toBe("approval-required");
    }),
  );
});
