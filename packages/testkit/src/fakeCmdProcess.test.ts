import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  EXIT_INTERRUPTED,
  EXIT_KILLED,
  framesToSteps,
  loadCmdFixture,
  makeFakeCmdProcess,
} from "./fakeCmdProcess";

const frameType = (line: string): string => {
  const parsed = JSON.parse(line) as { type: string; event?: { type?: string } };
  return parsed.type === "event" ? (parsed.event?.type ?? "event") : parsed.type;
};

describe("loadCmdFixture", () => {
  it.effect("fails loudly on a fixture that is not there", () =>
    Effect.gen(function* () {
      const error = yield* loadCmdFixture("nothing-like-this.ndjson").pipe(Effect.flip);
      expect(error._tag).toBe("FakeCmdFixtureError");
    }),
  );
});

describe("FakeCmdProcess replaying the captured run-error frames", () => {
  it.effect("puts every frame on stdout, in order, ending with the result line", () =>
    Effect.gen(function* () {
      const frames = yield* loadCmdFixture("run-error.ndjson");
      const process = yield* makeFakeCmdProcess({
        sessionId: "00000000-0000-7000-8000-000000000001",
        steps: [...framesToSteps(frames), { kind: "exit", code: 1 }],
      });

      yield* process.run;

      const lines = yield* Stream.runCollect(process.stdout);
      expect(lines.map(frameType)).toEqual([
        "run_start",
        "turn_start",
        "message_start",
        "model_request_start",
        "model_trace",
        "run_error",
        "run_end",
        "result",
      ]);
      expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
      expect(yield* process.exit).toBe(1);
      expect(yield* process.running).toBe(false);
    }),
  );

  it.effect("names the transcript after the session and writes the header first", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({
        sessionId: "00000000-0000-7000-8000-000000000001",
        cwd: "/tmp/workspace",
        steps: [],
      });

      expect(process.transcriptPath.endsWith("00000000-0000-7000-8000-000000000001.jsonl")).toBe(
        true,
      );
      const header = JSON.parse((yield* process.transcriptLines)[0] ?? "{}") as {
        type: string;
        cwd: string;
      };
      expect(header.type).toBe("session");
      expect(header.cwd).toBe("/tmp/workspace");
    }),
  );

  it.effect("appends transcript lines as the run goes, not at the end", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({
        steps: [
          { kind: "frame", frame: { type: "event", event: { type: "run_start" } } },
          { kind: "transcript", line: { type: "message", id: "m1" } },
          { kind: "transcript", line: { type: "message", id: "m2" } },
          { kind: "exit", code: 0 },
        ],
      });

      yield* process.advance;
      yield* process.advance;
      // Half the run is on disk while the process is still alive: this is what
      // the connector's byte-offset tailer reads.
      expect((yield* process.transcriptLines).length).toBe(2);
      expect(yield* process.running).toBe(true);

      yield* process.run;
      expect((yield* process.transcriptLines).length).toBe(3);
    }),
  );

  it.effect("stops at 130 on SIGINT and leaves the rest of the script unplayed", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({
        steps: [
          { kind: "frame", frame: { type: "event", event: { type: "run_start" } } },
          { kind: "frame", frame: { type: "event", event: { type: "turn_start" } } },
        ],
      });

      yield* process.advance;
      yield* process.signal("SIGINT");

      expect(yield* process.exit).toBe(EXIT_INTERRUPTED);
      expect(yield* process.advance).toBe(false);
      const lines = yield* Stream.runCollect(process.stdout);
      expect(lines.length).toBe(1);
    }),
  );

  it.effect("stops at 137 on SIGKILL", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({ steps: [] });
      yield* process.signal("SIGKILL");
      expect(yield* process.exit).toBe(EXIT_KILLED);
    }),
  );

  it.effect("answers hook posts through the handler it was given", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({
        steps: [],
        hook: () =>
          Effect.succeed({
            hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" },
          }),
      });

      const answer = yield* process.postHook({
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
      });

      expect(answer).toEqual({
        hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" },
      });
      expect((yield* process.hookCalls).length).toBe(1);
    }),
  );

  it.effect("allows by default, so a script that ignores permissions still runs", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeCmdProcess({ steps: [] });
      const answer = (yield* process.postHook({})) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(answer.hookSpecificOutput.permissionDecision).toBe("allow");
    }),
  );

  it.effect("cleans up the temp directory it made", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* makeFakeCmdProcess({ steps: [] });
          expect(NodeFS.existsSync(process.transcriptPath)).toBe(true);
          return process.directory;
        }),
      );

      expect(NodeFS.existsSync(directory)).toBe(false);
    }),
  );
});
