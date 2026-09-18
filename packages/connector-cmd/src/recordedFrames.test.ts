/**
 * The translator against every real recording in `testkit/fixtures/cmd`.
 *
 * These are captures of the real command-code CLI on 2026-09-18 — not
 * reconstructions — so this file is the connector's statement about what the
 * harness actually emits. Each manifest names the version it was taken on; the
 * connector runs whatever the user has installed, so they are not all the same
 * version and pinning them to one would be the pin this connector refuses to
 * have. Its first assertion is the blunt one: replaying a recording must not
 * produce a single `event.unmapped`. A new frame type in a later CLI fails here
 * rather than arriving as an unreadable blob in the timeline.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import { parseFrame, type CmdFrame } from "./ndjson";
import { isBelowOldestTested, OLDEST_TESTED_VERSION } from "./probe";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";
import { CMD_CAPABILITIES } from "./session";

const RECORDINGS = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd",
);

interface RecordedTurn {
  readonly sessionId: string;
  readonly exitCode: number;
  readonly connectorArgs: ReadonlyArray<string>;
  readonly hookCount: number;
  /** Workspace files the run created or changed, as the recorder diffed them. */
  readonly touchedFiles: ReadonlyArray<{ readonly name: string; readonly content: string | null }>;
  readonly files: { readonly stdout: string; readonly transcript?: string };
}

interface Manifest {
  readonly scenario: string;
  readonly cliVersion: string;
  readonly real: boolean;
  readonly turns: ReadonlyArray<RecordedTurn>;
}

const manifestOf = (scenario: string): Manifest =>
  JSON.parse(
    NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, "manifest.json"), "utf8"),
  ) as Manifest;

const linesOf = (scenario: string, file: string): ReadonlyArray<string> =>
  NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

const framesOf = (scenario: string, turn: RecordedTurn): ReadonlyArray<CmdFrame> =>
  linesOf(scenario, turn.files.stdout).map((line) => {
    const frame = parseFrame(line);
    if ("line" in frame) {
      throw new Error(`${scenario}: unparseable recorded frame — ${frame.message}`);
    }
    return frame;
  });

const translator = () =>
  makeTranslator({ connectorInstanceId: "instance", capabilities: CMD_CAPABILITIES });

/** Replays one recorded turn: frames, then its transcript, then the exit. */
const replay = (scenario: string, turnIndex = 0) => {
  const manifest = manifestOf(scenario);
  const turn = manifest.turns[turnIndex]!;
  const translate = translator();
  const events: Array<PendingRuntimeEvent> = [];
  for (const frame of framesOf(scenario, turn)) {
    events.push(...translate.onFrame(frame));
  }
  const transcript = turn.files.transcript;
  if (transcript !== undefined) {
    for (const line of linesOf(scenario, transcript)) {
      events.push(...translate.onTranscriptLine(JSON.parse(line)));
    }
  }
  events.push(...translate.onExit(turn.exitCode));
  return { manifest, turn, events, translate };
};

const typesOf = (events: ReadonlyArray<PendingRuntimeEvent>): ReadonlyArray<string> =>
  events.map((event) => event.type);

const itemsOf = (events: ReadonlyArray<PendingRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
      ? [event.payload.item]
      : [],
  );

/** Every scenario, and for the multi-turn ones every turn. */
const EVERY_TURN: ReadonlyArray<readonly [string, number]> = NodeFS.readdirSync(RECORDINGS, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && entry.name !== "probe")
  .flatMap((entry) => manifestOf(entry.name).turns.map((_, index) => [entry.name, index] as const));

describe("the recordings themselves", () => {
  it("are real captures, each on a version the connector supports", () => {
    expect(EVERY_TURN.length).toBeGreaterThanOrEqual(16);
    for (const [scenario] of EVERY_TURN) {
      const manifest = manifestOf(scenario);
      expect(manifest.real).toBe(true);
      // Not one pinned version — the operator's install moves, and so do the
      // recordings taken after it moved. What matters is that none of them
      // predates the floor the connector warns below.
      expect(manifest.cliVersion, `${scenario}: no CLI version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        isBelowOldestTested(manifest.cliVersion),
        `${scenario}: ${manifest.cliVersion} is older than ${OLDEST_TESTED_VERSION}`,
      ).toBe(false);
    }
  });
});

describe("every recorded frame is understood", () => {
  it.each(EVERY_TURN)("%s turn %i maps without a single event.unmapped", (scenario, index) => {
    const { events } = replay(scenario, index);
    const unmapped = events.filter((event) => event.type === "event.unmapped");
    expect(unmapped.map((event) => JSON.stringify(event.raw).slice(0, 200))).toEqual([]);
  });

  it.each(EVERY_TURN)("%s turn %i opens exactly one turn", (scenario, index) => {
    const { events } = replay(scenario, index);
    // One process is one user turn, however many agent steps it takes.
    expect(typesOf(events).filter((type) => type === "turn.started")).toHaveLength(1);
    expect(typesOf(events).filter((type) => type === "turn.completed")).toHaveLength(1);
  });

  it.each(EVERY_TURN)("%s turn %i leaves no row in progress", (scenario, index) => {
    const { events } = replay(scenario, index);
    const last = new Map<string, string>();
    for (const item of itemsOf(events)) {
      last.set(item.itemId, item.status);
    }
    // The interrupt recording is the one run that legitimately ends mid-thought.
    const stillWorking = [...last.values()].filter((status) => status === "in_progress");
    expect(stillWorking.length === 0 || scenario === "interrupt").toBe(true);
  });
});

describe("a text-only turn", () => {
  const { events, manifest } = replay("text");

  it("streams the answer and settles it on message_end", () => {
    expect(manifest.turns[0]!.sessionId).toBe("88bf4eee-c889-409a-a8f7-723a654b5344");
    const deltas = events.filter((event) => event.type === "content.delta");
    expect(deltas.map((event) => event.payload.delta)).toEqual(["ok"]);
    expect(deltas.every((event) => event.payload.kind === "text")).toBe(true);

    // The streamed row and the finished one are the same row: `message_end`
    // completes what `text_delta` opened, and the transcript replay after it
    // does not open a second.
    const answers = itemsOf(events).filter((item) => item.kind === "assistant_message");
    expect(new Set(answers.map((item) => item.itemId)).size).toBe(1);
    expect(answers.at(-1)?.status).toBe("completed");
    expect(answers.at(-1)?.text).toBe("ok");
  });

  it("reports the run's tokens and the transcript's dollars", () => {
    const usage = events.filter((event) => event.type === "usage.updated");
    // One per agent step while it works, one at run_end carrying the cost the
    // transcript priced the assistant message at.
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage.at(-1)?.payload.input).toBe(20126);
    expect(usage.at(-1)?.payload.output).toBe(17);
    expect(usage.at(-1)?.payload.costUsd).toBeCloseTo(0.002004926, 9);
  });
});

describe("a shell call through the hook", () => {
  it("shows the command, its output, and the same row throughout", () => {
    const { events } = replay("shell-yolo");
    const shell = itemsOf(events).filter((item) => item.kind === "command_execution");
    expect(new Set(shell.map((item) => item.itemId)).size).toBe(1);
    // `tool_queued` carries the input; `tool_running` carries neither input nor
    // description, and must not wipe what the row already shows.
    expect(shell.every((item) => item.command?.cmd === "cat note.txt")).toBe(true);
    expect(shell.at(-1)?.status).toBe("completed");
    expect(shell.at(-1)?.command?.output).toBe("hello\n");
  });

  it("fails the row when a hook — or the CLI's own ladder — blocks it", () => {
    const denied = itemsOf(replay("shell-deny").events).filter(
      (item) => item.kind === "command_execution",
    );
    expect(denied.at(-1)?.status).toBe("failed");
    expect(denied.at(-1)?.error?.message).toContain("recorded deny from the recording hook");

    // shell-allow ran *without* `--yolo`: the hook said allow and print mode
    // refused anyway. That is why the connector always passes `--yolo`.
    const refused = itemsOf(replay("shell-allow").events).filter(
      (item) => item.kind === "command_execution",
    );
    expect(refused.at(-1)?.status).toBe("failed");
    expect(refused.at(-1)?.error?.message).toContain("requires permissions");
  });
});

describe("thinking, files and MCP", () => {
  it("turns thinking_* into a reasoning row", () => {
    const reasoning = itemsOf(replay("resume", 1).events).filter(
      (item) => item.kind === "reasoning",
    );
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.at(-1)?.status).toBe("completed");
    expect(reasoning.at(-1)?.text?.length).toBeGreaterThan(0);
  });

  it("reads an edit as a file_change on its real path", () => {
    const changes = itemsOf(replay("file-edit").events).filter(
      (item) => item.kind === "file_change",
    );
    expect(changes.at(-1)?.fileChange?.path).toContain("greeting.txt");
    expect(changes.at(-1)?.fileChange?.kind).toBe("edit");
    expect(changes.at(-1)?.status).toBe("completed");
  });

  it("reads mcp__server__tool as an MCP call, server and all", () => {
    const calls = itemsOf(replay("mcp").events).filter((item) => item.kind === "mcp_tool_call");
    expect(calls.at(-1)?.tool?.name).toBe("mcp__rec__echo");
    expect(calls.at(-1)?.tool?.server).toBe("rec");
    expect(calls.at(-1)?.tool?.output).toBe("echo: hi");
    expect(calls.at(-1)?.status).toBe("completed");
  });

  /**
   * The `agent` call is one `task` row; the subagent's own steps only ever
   * appear as progress on it, because no PreToolUse hook fires for them. If
   * these frames stopped being read the row would sit silent for the whole
   * delegation and the user would never learn what the subagent touched.
   */
  it("shows a subagent's steps as progress on the task row that spawned it", () => {
    const { events } = replay("subagent");
    const tasks = events.flatMap((event) =>
      (event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      event.payload.item.kind === "task"
        ? [event.payload.item]
        : [],
    );
    expect(tasks.length).toBeGreaterThan(0);
    const outputs = tasks.map((item) => String(item.tool?.output ?? ""));
    // The inner call the subagent made, named as it happened.
    expect(outputs.some((text) => text.includes("general subagent: read_file note.txt"))).toBe(
      true,
    );
    expect(outputs.some((text) => text.includes("general subagent started"))).toBe(true);
    expect(outputs.some((text) => /general subagent finished \(\d+ tokens\)/.test(text))).toBe(
      true,
    );
    // And the delegation itself ends as one completed row carrying the answer.
    expect(tasks.at(-1)?.status).toBe("completed");
    expect(tasks.at(-1)?.tool?.output).toContain("hello");
  });

  it("keeps an image tool result's bytes out of the row", () => {
    const reads = itemsOf(replay("image").events).filter((item) => item.kind === "tool_call");
    const output = String(reads.at(-1)?.tool?.output ?? "");
    expect(output).toContain("Read image red.png");
    // The harness answers with a base64 image block beside the text; only the
    // text may reach an event, or the log grows by a megabyte per screenshot.
    expect(output).not.toContain("base64");
    expect(output.length).toBeLessThan(500);
  });
});

describe("how runs end", () => {
  it("settles max_turns from the result frame", () => {
    const { events } = replay("max-turns");
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload.stopReason).toBe("max_turns");
  });

  it("settles an interrupt from the exit code, with no run_end to help", () => {
    const { events, turn } = replay("interrupt");
    expect(turn.exitCode).toBe(130);
    // SIGINT leaves no run_end and no result line at all.
    expect(typesOf(events)).not.toContain("runtime.error");
    expect(events.find((event) => event.type === "turn.completed")?.payload.stopReason).toBe(
      "interrupted",
    );
  });

  /**
   * The one recording that cannot be made again: the account had no credits on
   * 2026-09-15 and the run died at the model call. It is the only real capture
   * of `run_error` and of the exit-10 path, so it is kept in the raw shape the
   * first probe wrote it in — stderr and stdout in one file.
   */
  it("turns a run_error into a fatal runtime error", () => {
    const raw = NodeFS.readFileSync(
      NodePath.join(RECORDINGS, "probe-insufficient-credits.ndjson"),
      "utf8",
    );
    const translate = translator();
    const events: Array<PendingRuntimeEvent> = [];
    for (const line of raw.split("\n")) {
      const frame = parseFrame(line);
      if (!("line" in frame)) {
        events.push(...translate.onFrame(frame));
      }
    }
    events.push(...translate.onExit(10));

    const errors = events.filter((event) => event.type === "runtime.error");
    expect(errors.map((event) => event.payload.fatal)).toEqual([true, true, true]);
    expect(errors[0]?.payload.message).toContain("insufficient credits");
    // Exit 10 is named, so the user is told to top up rather than shown a code.
    expect(errors.at(-1)?.payload.message.toLowerCase()).toContain("credits");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("carries a question's answer-shaped tool call as an ordinary row", () => {
    // `--tools-enable ask_user_question` un-withholds the tool; the card itself
    // comes from the hook, but the timeline still shows the call.
    const asked = itemsOf(replay("question-tools").events).filter(
      (item) => item.tool?.name === "ask_user_question",
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)?.status).toBe("failed");
  });
});

/**
 * The approval gate, under the argv the connector really spawns.
 *
 * Every turn carries `--yolo`, which turns off the CLI's own print-mode refusal
 * of writes and shell calls. That leaves our PreToolUse hook as the only thing
 * between a model and the machine — and commit "hand the hook its bearer in a
 * file" showed that this gate's failure mode is to open silently. So the deny
 * is recorded against exactly that argv rather than inferred from a run the CLI
 * would have refused on its own.
 */
describe("a PreToolUse deny under --yolo", () => {
  const manifest = manifestOf("shell-deny-yolo");
  const turn = manifest.turns[0]!;
  const hooks = JSON.parse(
    NodeFS.readFileSync(NodePath.join(RECORDINGS, "shell-deny-yolo", "hooks.json"), "utf8"),
  ) as ReadonlyArray<{
    stdin: { tool_name: string; tool_input: { command?: string }; permission_mode?: string };
    answer: { hookSpecificOutput: { permissionDecision: string } };
  }>;

  it("was recorded with --yolo on and the hook answering deny", () => {
    expect(turn.connectorArgs).toContain("--yolo");
    expect(turn.connectorArgs.join(" ")).toContain("--tools-enable ask_user_question");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.stdin.tool_name).toBe("shell_command");
    expect(hooks[0]!.answer.hookSpecificOutput.permissionDecision).toBe("deny");
    // `--yolo` is what the CLI calls "bypass" — its own gate really is off.
    expect(hooks[0]!.stdin.permission_mode).toBe("bypass");
  });

  it("stopped the call: the command never ran and the file was never made", () => {
    const { events } = replay("shell-deny-yolo");
    const shell = itemsOf(events).filter((item) => item.kind === "command_execution");
    expect(shell.at(0)?.command?.cmd).toBe("cp note.txt copied.txt");
    expect(shell.at(-1)?.status).toBe("failed");
    // The side effect the command would have had. The recorder diffs the whole
    // workspace, so an empty list is the file's absence, not an unchecked hope.
    expect(turn.touchedFiles).toEqual([]);
  });
});
