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
import { readableAnswers } from "./questions";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";
import { CMD_CAPABILITIES } from "./capabilities";

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

/**
 * Whether the harness actually started a run for this turn.
 *
 * Every real run opens with `run_start`. A run it refused outright — the one
 * recorded case is `--session` naming a session whose transcript was never
 * written — answers with a single `result` frame instead, so there is no turn
 * to assert anything about. The recording itself says which is which; nothing
 * here is a hand-kept list.
 */
const didStart = ([scenario, index]: readonly [string, number]): boolean =>
  framesOf(scenario, manifestOf(scenario).turns[index]!).some(
    (frame) => frame.type === "event" && frame.event.type === "run_start",
  );

const STARTED_TURNS = EVERY_TURN.filter(didStart);
const REFUSED_TURNS = EVERY_TURN.filter((turn) => !didStart(turn));

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

  it.each(STARTED_TURNS)("%s turn %i opens exactly one turn", (scenario, index) => {
    const { events } = replay(scenario, index);
    // One process is one user turn, however many agent steps it takes.
    expect(typesOf(events).filter((type) => type === "turn.started")).toHaveLength(1);
    expect(typesOf(events).filter((type) => type === "turn.completed")).toHaveLength(1);
  });

  it.each(REFUSED_TURNS)("%s turn %i is a run the harness refused to start", (scenario, index) => {
    // The counter-example the two assertions above are scoped against, and the
    // reason `sessionRef.ts` checks the filesystem before it resumes: handed
    // `--session <id>` for a session with no transcript, the harness answers
    // with one `result` frame and exits — there is no run, so there is no turn
    // to open and nothing for the translator to do but say so.
    const { turn, events } = replay(scenario, index);
    expect(turn.exitCode).not.toBe(0);
    expect(typesOf(events)).not.toContain("turn.started");
    const errors = events.filter((event) => event.type === "runtime.error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(STARTED_TURNS)("%s turn %i leaves no row in progress", (scenario, index) => {
    const { events } = replay(scenario, index);
    const last = new Map<string, string>();
    for (const item of itemsOf(events)) {
      last.set(item.itemId, item.status);
    }
    // No exception for `interrupt`: a run that ends mid-thought still has to
    // settle the row it was streaming on, or the timeline spins forever under
    // a thread that reads idle.
    const stillWorking = [...last.values()].filter((status) => status === "in_progress");
    expect(stillWorking).toEqual([]);
  });
});

/**
 * Thinking and the answer are two rows, in every recording that has both.
 *
 * The real CLI's deltas are anonymous — `{"type":"text_delta","delta":"ok"}`,
 * no message id, no index — and an agent step streams `thinking_delta*` and
 * then `text_delta*` inside one such run. Keyed without the kind, both landed
 * on one row: the answer arrived as a `content.delta` on the finished
 * reasoning row, and the `message_end` thinking block, no longer able to find
 * the row it had streamed on, minted a second reasoning row beside it. The
 * statuses were all correct, which is why the assertions above never noticed.
 */
describe("a turn that thinks before it answers", () => {
  const THINKING_TURNS = STARTED_TURNS.filter(([scenario, index]) =>
    framesOf(scenario, manifestOf(scenario).turns[index]!).some(
      (frame) => frame.type === "event" && frame.event.type === "thinking_end",
    ),
  );

  it("has recordings to say it about", () => {
    expect(THINKING_TURNS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(THINKING_TURNS)("%s turn %i opens one row per thinking block", (scenario, index) => {
    const { events } = replay(scenario, index);
    const thoughts = framesOf(scenario, manifestOf(scenario).turns[index]!).filter(
      (frame) => frame.type === "event" && frame.event.type === "thinking_end",
    );
    const reasoning = new Set(
      itemsOf(events)
        .filter((item) => item.kind === "reasoning")
        .map((item) => item.itemId),
    );
    expect(reasoning.size).toBe(thoughts.length);
  });

  it.each(THINKING_TURNS)(
    "%s turn %i keeps the answer off the reasoning row",
    (scenario, index) => {
      const { events } = replay(scenario, index);
      const finalText = framesOf(scenario, manifestOf(scenario).turns[index]!).flatMap((frame) =>
        frame.type === "event" && frame.event.type === "run_end"
          ? [frame.event.result?.finalText ?? ""]
          : [],
      )[0];
      if (finalText === undefined || finalText.trim() === "") {
        return;
      }
      const reasoningIds = new Set(
        itemsOf(events)
          .filter((item) => item.kind === "reasoning")
          .map((item) => item.itemId),
      );
      for (const item of itemsOf(events)) {
        if (item.kind === "reasoning") {
          expect(item.text ?? "", `${scenario}: the answer is on a reasoning row`).not.toContain(
            finalText,
          );
        }
      }
      // Nor as a stray `content.delta` addressed to a reasoning row.
      for (const event of events) {
        if (event.type === "content.delta" && reasoningIds.has(event.payload.itemId)) {
          expect(event.payload.kind, `${scenario}: text delta on a reasoning row`).toBe(
            "reasoning",
          );
        }
      }
    },
  );
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

  it("reports how full the context is, once the probe has said how big it is", () => {
    // The composer toolbar's "Context window used" percentage needs both
    // halves. `run_end` has carried the used tokens in all 24 recordings; the
    // ceiling comes from `status --json`'s `context_window`, which the probe
    // caches (1048576 on the recorded capture).
    const withLimit = makeTranslator({
      connectorInstanceId: "instance",
      capabilities: CMD_CAPABILITIES,
      contextLimit: 1_048_576,
    });
    const turn = manifestOf("text").turns[0]!;
    const informed = framesOf("text", turn).flatMap((frame) => withLimit.onFrame(frame));
    const context = informed.filter((event) => event.type === "context.updated");
    expect(context).toHaveLength(1);
    expect(context[0]?.payload).toEqual({ used: 20133, limit: 1_048_576 });

    // Without a limit there is no percentage to report, so nothing is said.
    expect(events.filter((event) => event.type === "context.updated")).toEqual([]);
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

describe("the effort a run really used", () => {
  it("says so, and says it once", () => {
    // `model_request_end` is the only frame that names the effort, and on the
    // account default it is `xhigh` — a rung the picker never offered and the
    // header never showed, so the run read as whatever the thread's settings
    // last said. The frame's `effort` was read off the wire and dropped.
    const { events } = replay("text");
    const changes = events.filter((event) => event.type === "model.changed");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.at(-1)?.payload.effort).toBe("xhigh");
    expect(changes.at(-1)?.payload.model).toBe("meta/muse-spark-1.3-contributor");
    // One `model_request_end` per agent step, all reporting the same level:
    // a `thread.settings.updated` per step would feed the reactor for nothing.
    const withEffort = changes.filter((event) => event.payload.effort !== undefined);
    expect(withEffort).toHaveLength(1);
  });

  it("reports the level of every step that changes it", () => {
    const { events } = replay("shell-yolo");
    const efforts = events.flatMap((event) =>
      event.type === "model.changed" && event.payload.effort !== undefined
        ? [event.payload.effort]
        : [],
    );
    expect(efforts).toEqual(["xhigh"]);
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
    // The row the run was mid-thought on is completed with what it streamed,
    // and it is completed *before* the turn is — after `turn.completed` the
    // engine no longer tags events with that turn.
    const reasoning = itemsOf(events).filter((item) => item.kind === "reasoning");
    expect(reasoning.at(-1)?.status).toBe("completed");
    expect(reasoning.at(-1)?.text?.length).toBeGreaterThan(0);
    const settledAt = events.findIndex(
      (event) => event.type === "item.completed" && event.payload.item.kind === "reasoning",
    );
    const completedAt = events.findIndex((event) => event.type === "turn.completed");
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(settledAt).toBeLessThan(completedAt);
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

    // One failure, one fatal error — and since commit 427a082 every fatal
    // runtime.error also plants its own `error` row, so three of them were
    // three red rows and three `thread.error` status changes for one turn.
    // The `result` frame's wording wins: it is the one carrying the billing URL.
    const errors = events.filter((event) => event.type === "runtime.error");
    expect(errors.map((event) => event.payload.fatal)).toEqual([true]);
    expect(errors[0]?.payload.message).toContain("insufficient credits");
    expect(errors[0]?.payload.message).toContain("https://commandcode.ai/billing");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("reports a refused resume once, not twice", () => {
    // `--session` naming a transcript that was never written: the CLI answers
    // with one `result` frame and exits 1. The generic "cmd failed — see the
    // output above" that exit 1 is named for adds nothing to the CLI's own
    // sentence, and used to arrive as a second red row beside it.
    const { events } = replay("interrupt-resume", 1);
    const errors = events.filter((event) => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload.message).toContain("neither an existing .jsonl transcript");
  });

  it("shows an answered question as an answer, not as a failure", () => {
    // `--tools-enable ask_user_question` un-withholds the tool; the card comes
    // from the hook, and the bridge answers it by *denying* the call with the
    // user's answers as the reason (that is how the harness reads them as
    // context). The CLI reports that as `tool_hook_blocked` — so the row used
    // to be red and failed, with the user's own answer as its error message
    // and "Do not retry this tool" underneath it.
    const events = replay("question-tools").events;
    const asked = itemsOf(events).filter((item) => item.tool?.name === "ask_user_question");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)?.status).toBe("completed");
    expect(asked.at(-1)?.error).toBeUndefined();
    // The policy sentence is addressed to the model, not to the reader.
    expect(String(asked.at(-1)?.tool?.output ?? "")).not.toContain("Blocked by hook policy");
    // One row, whatever the frames and the transcript both say about it.
    expect(new Set(asked.map((item) => item.itemId)).size).toBe(1);
  });

  it("renders the answers the bridge handed back", () => {
    expect(readableAnswers('[{"question":"Tabs or spaces?","selected":["Tabs"]}]')).toBe(
      "Tabs or spaces? → Tabs",
    );
    expect(
      readableAnswers(
        '[{"question":"Which?","selected":["A"]}]\n\n(Blocked by hook policy. Do not retry this tool — choose another approach.)',
      ),
    ).toBe("Which? → A");
    // Anything that is not the bridge's own JSON is shown as it came.
    expect(readableAnswers("recorded deny from the recording hook")).toBe(
      "recorded deny from the recording hook",
    );
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

/**
 * Plan mode, told in as many words to mutate the workspace.
 *
 * What these two recordings show, and it is worth stating plainly: a plan turn
 * has no gate of ours at all. PreToolUse never fires in plan mode — `hookCount`
 * is 0 in every plan recording, including one whose `read_file` fires a hook in
 * an ordinary run — and `--yolo` takes away the CLI's refusal as well. The
 * workspace survives because the model's plan ladder holds, which is worth
 * recording and is not the same thing as enforcement.
 */
describe("plan mode under --yolo", () => {
  it.each(["plan-guard", "plan-write"])("%s leaves the workspace untouched", (scenario) => {
    const turn = manifestOf(scenario).turns[0]!;
    expect(turn.connectorArgs).toContain("--yolo");
    expect(turn.connectorArgs.join(" ")).toContain("--permission-mode plan");
    expect(turn.touchedFiles).toEqual([]);
  });

  it("never fires a PreToolUse hook, however many tools the turn queues", () => {
    for (const scenario of ["plan", "plan-guard", "plan-no-yolo", "plan-write"]) {
      const first = manifestOf(scenario).turns[0]!;
      expect(first.connectorArgs.join(" "), scenario).toContain("--permission-mode plan");
      expect(first.hookCount, `${scenario}: a plan turn fired a hook`).toBe(0);
    }
    // ...while the same tools do fire one outside plan mode.
    expect(manifestOf("file-edit").turns[0]!.hookCount).toBeGreaterThan(0);
  });
});
