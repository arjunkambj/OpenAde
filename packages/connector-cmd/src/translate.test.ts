/**
 * The translator's contract: NDJSON frames, transcript lines and process exit
 * all describe the same work, and every overlapping source has to land on one
 * timeline row. These tests replay the real captured run (the
 * insufficient-credits probe from w2-cmd-frames.md) and drive the dedupe paths
 * by hand, because the live CLI needs credits this account does not have.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

import { parseFrame, type CmdEventFrame, type CmdFrame, type CmdFrameParseError } from "./ndjson";
import { MAX_TOOL_OUTPUT_CHARS } from "./items";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";

const CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: true,
  subagents: true,
  images: false,
  resume: true,
  fork: true,
};

const translator = () =>
  makeTranslator({
    connectorInstanceId: "00000000-0000-7000-8000-000000000099",
    capabilities: CAPABILITIES,
  });

const translatorWith = (options: { readonly resumeAfterMessageId?: string | null }) =>
  makeTranslator({
    connectorInstanceId: "00000000-0000-7000-8000-000000000099",
    capabilities: CAPABILITIES,
    ...options,
  });

/** The session's stdout path: a line either parses to a frame or surfaces as unmapped. */
const feedLine = (
  translate: ReturnType<typeof translator>,
  line: string,
): ReadonlyArray<PendingRuntimeEvent> => {
  const frame = parseFrame(line);
  return "line" in frame
    ? [
        {
          type: "event.unmapped" as const,
          payload: {},
          raw: { source: "cmd.ndjson", payload: frame },
        },
      ]
    : translate.onFrame(frame);
};

const fixtureLines = (name: string): Array<string> =>
  NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
      "..",
      "testkit",
      "fixtures",
      "cmd",
      name,
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0);

const types = (events: ReadonlyArray<PendingRuntimeEvent>): Array<string> =>
  events.map((event) => event.type);

const frame = (event: Record<string, unknown>): CmdFrame => ({
  type: "event",
  event: event as CmdEventFrame["event"],
});

const runStart = (sessionId = "sess-1") => frame({ type: "run_start", sessionId });

const turnStart = () => frame({ type: "turn_start", turnNumber: 1 });

const runEnd = (
  stopReason = "end_turn",
  messages: ReadonlyArray<unknown> = [],
  usage: Record<string, number> = {
    inputTokens: 3,
    outputTokens: 7,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
  },
) =>
  frame({
    type: "run_end",
    result: {
      finalText: "",
      stopReason,
      turnCount: 1,
      usage,
      nextState: { sessionId: "sess-1", messages, interrupted: false },
    },
  });

const message = (
  role: string,
  content: ReadonlyArray<unknown>,
  messageId: string,
  source = role === "user" ? "user" : "model",
) => ({
  role,
  content,
  meta: { source, createdAt: 1, messageId },
});

const transcriptMessage = (
  role: string,
  content: ReadonlyArray<unknown>,
  messageId: string,
  source?: string,
) => ({
  type: "message",
  id: `line-${messageId}`,
  parentId: null,
  timestamp: "2026-09-18T00:00:00.000Z",
  message: message(role, content, messageId, source ?? (role === "user" ? "user" : "model")),
});

describe("fixture replay: the captured insufficient-credits run", () => {
  it("translates the real ndjson into a failed turn", () => {
    const translate = translator();
    const events = fixtureLines("probe-insufficient-credits.ndjson").flatMap((line) =>
      feedLine(translate, line),
    );

    // The session announces itself once, before any work.
    expect(events[0]?.type).toBe("event.unmapped"); // the stderr "session: <id>" line
    expect(types(events)).toEqual([
      "event.unmapped",
      "session.started",
      "turn.started",
      "model.changed",
      "runtime.error",
      "usage.updated",
      "turn.completed",
      "runtime.error",
      "event.unmapped",
    ]);

    const started = events.find((event) => event.type === "session.started");
    expect(started?.type === "session.started" && started.payload.capabilities).toEqual(
      CAPABILITIES,
    );
    expect(translate.sessionId).toBe("36a3ded1-5c99-4896-bc81-d1c63517d482");

    const failure = events.find((event) => event.type === "runtime.error");
    expect(
      failure?.type === "runtime.error" && failure.payload.message.includes("insufficient credits"),
    ).toBe(true);
    expect(failure?.type === "runtime.error" && failure.payload.fatal).toBe(true);

    // The user's prompt does NOT become a user_message item: the engine's
    // turn.requested fold owns that row — re-emitting it duplicated the prompt.
    expect(events.some((event) => event.type.startsWith("item."))).toBe(false);

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload.stopReason === "error").toBe(
      true,
    );

    // turn.completed exactly once: the result line and exit must not re-emit.
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    const onExit = translate.onExit(1);
    expect(onExit.some((event) => event.type === "turn.completed")).toBe(false);
  });
});

describe("turn lifecycle", () => {
  /**
   * One process is one user turn, so `run_start` opens it (spec section 8 step
   * 5). The harness's own `turn_start` counts agent steps — `shell-allow/` has
   * three of them inside one turn — and must not open a turn of its own.
   */
  it("announces the session once across turns of the same session", () => {
    const translate = translator();
    expect(types(translate.onFrame(runStart()))).toEqual(["session.started", "turn.started"]);
    expect(types(translate.onFrame(turnStart()))).toEqual([]);
    expect(types(translate.onFrame(runEnd()))).toEqual(["usage.updated", "turn.completed"]);
    // Next turn's process: same sessionId → no second session.started, but it
    // is a new turn.
    expect(types(translate.onFrame(runStart()))).toEqual(["turn.started"]);
    expect(types(translate.onFrame(turnStart()))).toEqual([]);
  });

  it("announces again when the harness hands back a different session id", () => {
    const translate = translator();
    translate.onFrame(runStart("sess-1"));
    const events = translate.onFrame(runStart("sess-2"));
    expect(types(events)).toEqual(["session.started", "turn.started"]);
    expect(translate.sessionId).toBe("sess-2");
  });

  it("emits model.changed only when the value actually changes", () => {
    const translate = translator();
    expect(types(translate.onFrame(frame({ type: "model_request_start" })))).toEqual([]);
    const changed = translate.onFrame(
      frame({ type: "model_request_start", model: "stealth/ox-alpha" }),
    );
    expect(
      changed[0]?.type === "model.changed" && changed[0].payload.model === "stealth/ox-alpha",
    ).toBe(true);
    // A second model_request_start for the same model is not a change —
    // model.changed spam would loop thread.settings.updated into the reactor.
    expect(
      types(translate.onFrame(frame({ type: "model_request_start", model: "stealth/ox-alpha" }))),
    ).toEqual([]);
    // A real change still emits.
    const again = translate.onFrame(
      frame({ type: "model_request_start", model: "stealth/ox-beta" }),
    );
    expect(again[0]?.type === "model.changed" && again[0].payload.model).toBe("stealth/ox-beta");
  });

  it("run_error is a fatal runtime.error", () => {
    const translate = translator();
    const events = translate.onFrame(
      frame({ type: "run_error", error: { name: "TransportError", message: "boom" } }),
    );
    expect(events).toEqual([{ type: "runtime.error", payload: { message: "boom", fatal: true } }]);
  });

  it("result subtype error is a fatal runtime.error and ends the turn once", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const events = translate.onFrame({
      type: "result",
      subtype: "error",
      sessionId: "sess-1",
      error: "Error: nope",
    });
    expect(types(events)).toEqual(["runtime.error", "turn.completed"]);
    expect(events[1]?.type === "turn.completed" && events[1].payload.stopReason === "error").toBe(
      true,
    );
  });

  it("maps stopReason onto turn.completed", () => {
    for (const [stopReason, expected] of [
      ["end_turn", "end_turn"],
      ["run_error", "error"],
      ["max_turns", "max_turns"],
      ["interrupted", "interrupted"],
      ["something-new", "error"],
    ] as const) {
      const translate = translator();
      translate.onFrame(runStart());
      const events = translate.onFrame(runEnd(stopReason));
      const completed = events.find((event) => event.type === "turn.completed");
      expect(
        completed?.type === "turn.completed" && completed.payload.stopReason === expected,
        `${stopReason} → ${expected}`,
      ).toBe(true);
    }
  });
});

describe("exit-code mapping", () => {
  it("turns exit 3 into a fatal auth error", () => {
    const translate = translator();
    const events = translate.onExit(3);
    expect(events[0]?.type === "runtime.error" && events[0].payload.fatal).toBe(true);
    expect(events[0]?.type === "runtime.error" && events[0].payload.message).toContain("cmd login");
  });

  it("turns exit 10 into a fatal insufficient-credits error with the billing link", () => {
    const translate = translator();
    const events = translate.onExit(10);
    expect(events[0]?.type === "runtime.error" && events[0].payload.message).toContain(
      "commandcode.ai/billing",
    );
  });

  it("settles an open turn on exit: 130 interrupted, 8 max_turns, other error", () => {
    for (const [code, expected] of [
      [130, "interrupted"],
      [8, "max_turns"],
      [1, "error"],
      [0, "end_turn"],
    ] as const) {
      const translate = translator();
      translate.onFrame(runStart());
      translate.onFrame(turnStart());
      const events = translate.onExit(code);
      const completed = events.find((event) => event.type === "turn.completed");
      expect(
        completed?.type === "turn.completed" && completed.payload.stopReason === expected,
        `exit ${code} → ${expected}`,
      ).toBe(true);
    }
  });

  it("gives every exit code spec 5.1 names a message of its own", () => {
    for (const code of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const events = translator().onExit(code);
      const error = events[0];
      expect(error?.type, `exit ${code}`).toBe("runtime.error");
      const message = error?.type === "runtime.error" ? error.payload.message : "";
      // Not the "cmd exited with code N" fallback, which is not a message a
      // user can act on.
      expect(message, `exit ${code}`).not.toContain(`code ${code}`);
      expect(message.length, `exit ${code}`).toBeGreaterThan(10);
    }
  });

  it("leaves the session alive for the three retryable failures", () => {
    const fatalFor = (code: number): boolean | undefined => {
      const error = translator().onExit(code)[0];
      return error?.type === "runtime.error" ? error.payload.fatal : undefined;
    };
    // Rate limit, network, api 5xx, and the turn limit: worth another go, so
    // the supervisor backs off instead of killing the thread.
    expect([5, 6, 7, 8].map(fatalFor)).toEqual([false, false, false, false]);
    expect([1, 3, 4, 9, 10].map(fatalFor)).toEqual([true, true, true, true, true]);
  });

  it("says nothing when the process exits cleanly with no open turn", () => {
    expect(translator().onExit(0)).toEqual([]);
    // An interrupt is not a failure — the stop reason already says so.
    expect(translator().onExit(130)).toEqual([]);
  });
});

describe("tool calls dedupe on tool_use.id across ndjson and transcript", () => {
  it("tool_running then the transcript's tool_use lands on one item", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());

    const running = translate.onFrame(
      frame({
        type: "tool_running",
        toolCallId: "tool-1",
        toolName: "shell_command",
        description: "List files",
      }),
    );
    expect(running).toHaveLength(1);
    const started = running[0]!;
    expect(started.type === "item.started" && started.payload.item.kind).toBe("command_execution");
    const itemId = started.type === "item.started" ? started.payload.item.itemId : undefined;

    // The transcript's tool_use block for the same call updates, not duplicates.
    const viaTranscript = translate.onTranscriptLine(
      transcriptMessage(
        "assistant",
        [{ type: "tool_use", id: "tool-1", name: "shell_command", input: { command: "ls" } }],
        "msg-tool",
      ),
    );
    expect(viaTranscript).toHaveLength(1);
    const updated = viaTranscript[0]!;
    expect(updated.type === "item.updated" && updated.itemId === itemId).toBe(true);
    expect(updated.type === "item.updated" && updated.payload.item.command?.cmd === "ls").toBe(
      true,
    );
    // A duplicate frame does not regress a completed row — here still in progress.
    expect(updated.type === "item.updated" && updated.payload.item.status).toBe("in_progress");

    // The tool_result completes the same row with its output.
    const result = translate.onTranscriptLine(
      transcriptMessage(
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "a.txt\nb.txt" }],
          },
        ],
        "msg-result",
        "tool",
      ),
    );
    expect(result).toHaveLength(1);
    const completed = result[0]!;
    expect(completed.type === "item.completed" && completed.itemId === itemId).toBe(true);
    expect(
      completed.type === "item.completed" &&
        completed.payload.item.command?.output === "a.txt\nb.txt" &&
        completed.payload.item.status === "completed",
    ).toBe(true);
  });

  it("maps the tool vocabulary of spec 5.4 onto item kinds", () => {
    const translate = translator();
    const cases: ReadonlyArray<[string, unknown, string]> = [
      ["edit_file", { file_path: "a.ts" }, "file_change"],
      ["write_file", { file_path: "a.ts", content: "x" }, "file_change"],
      ["read_file", { file_path: "a.ts" }, "tool_call"],
      ["glob", { pattern: "*.ts" }, "tool_call"],
      ["todo_write", { todos: [{ text: "do it", status: "pending" }] }, "todo"],
      ["agent", { prompt: "research" }, "task"],
      ["activate_skill", { name: "pdf" }, "skill"],
      ["web_search", { query: "q" }, "web_search"],
      ["web_fetch", { url: "https://x" }, "web_search"],
      ["mcp__github__get_issue", { number: 1 }, "mcp_tool_call"],
    ];
    for (const [toolName, input, kind] of cases) {
      const events = translate.onTranscriptLine(
        transcriptMessage(
          "assistant",
          [{ type: "tool_use", id: `use-${toolName}`, name: toolName, input }],
          `msg-${toolName}`,
        ),
      );
      const item = events[0];
      expect(
        item?.type === "item.started" && item.payload.item.kind === kind,
        `${toolName} → ${kind}`,
      ).toBe(true);
    }
    const mcp = translate.onTranscriptLine(
      transcriptMessage(
        "assistant",
        [
          {
            type: "tool_use",
            id: "use-mcp",
            name: "mcp__openade__click",
            input: { x: 1 },
          },
        ],
        "msg-mcp-2",
      ),
    )[0];
    expect(mcp?.type === "item.started" && mcp.payload.item.tool?.server).toBe("openade");
  });

  it("truncates tool output past 64KB with a marker", () => {
    const translate = translator();
    const giant = "y".repeat(MAX_TOOL_OUTPUT_CHARS + 5000);
    const events = translate.onTranscriptLine(
      transcriptMessage(
        "user",
        [{ type: "tool_result", tool_use_id: "big", content: [{ type: "text", text: giant }] }],
        "msg-big",
        "tool",
      ),
    );
    const item = events[0];
    if (item?.type !== "item.completed") {
      throw new Error("expected item.completed");
    }
    const output = item.payload.item.tool?.output;
    expect(typeof output).toBe("string");
    expect(output as string).toHaveLength(MAX_TOOL_OUTPUT_CHARS + "...[truncated]".length);
    expect((output as string).endsWith("...[truncated]")).toBe(true);
    expect((output as string).startsWith("yyy")).toBe(true);
  });

  it("marks is_error tool results failed", () => {
    const translate = translator();
    const events = translate.onTranscriptLine(
      transcriptMessage(
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: "nope",
            content: [{ type: "text", text: "denied" }],
            is_error: true,
          },
        ],
        "msg-err",
        "tool",
      ),
    );
    const item = events[0];
    expect(
      item?.type === "item.completed" &&
        item.payload.item.status === "failed" &&
        item.payload.item.error?.message === "denied",
    ).toBe(true);
  });
});

describe("anonymous messages key by content hash, not block index", () => {
  /** A transcript line whose message carries no meta.messageId. */
  const anonymousLine = (role: string, content: ReadonlyArray<unknown>) => ({
    type: "message",
    id: "line-anon",
    parentId: null,
    timestamp: "2026-09-18T00:00:00.000Z",
    message: { role, content, meta: { source: "model", createdAt: 1 } },
  });

  it("two different anonymous messages no longer share one itemId", () => {
    const translate = translator();
    // Pre-fix both keyed as `anon:0` — the second row overwrote the first.
    const first = translate.onTranscriptLine(
      anonymousLine("assistant", [{ type: "text", text: "first" }]),
    );
    const second = translate.onTranscriptLine(
      anonymousLine("assistant", [{ type: "text", text: "second" }]),
    );
    expect(types(first)).toEqual(["item.completed"]);
    expect(types(second)).toEqual(["item.completed"]);
    const itemA = first[0]?.type === "item.completed" ? first[0].payload.item.itemId : undefined;
    const itemB = second[0]?.type === "item.completed" ? second[0].payload.item.itemId : undefined;
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemA).not.toBe(itemB);
  });

  it("the same anonymous message re-delivered dedupes — via transcript or nextState", () => {
    const translate = translator();
    const line = anonymousLine("assistant", [{ type: "text", text: "same" }]);
    expect(types(translate.onTranscriptLine(line))).toEqual(["item.completed"]);
    expect(translate.onTranscriptLine(line)).toEqual([]);

    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const end = translate.onFrame(runEnd("end_turn", [line.message]));
    expect(end.filter((event) => event.type.startsWith("item."))).toEqual([]);
  });

  it("anonymous tool_use blocks in one message get distinct stable rows", () => {
    const translate = translator();
    const events = translate.onTranscriptLine(
      anonymousLine("assistant", [
        { type: "tool_use", name: "glob", input: { pattern: "*.ts" } },
        { type: "tool_use", name: "grep", input: { pattern: "x" } },
      ]),
    );
    expect(types(events)).toEqual(["item.started", "item.started"]);
    const ids = events.map((event) => (event.type === "item.started" ? event.itemId : null));
    expect(ids[0]).not.toBe(ids[1]);
    // Re-delivery is a no-op at message level — no duplicate item.started.
    expect(
      translate.onTranscriptLine(
        anonymousLine("assistant", [
          { type: "tool_use", name: "glob", input: { pattern: "*.ts" } },
          { type: "tool_use", name: "grep", input: { pattern: "x" } },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("resume markers", () => {
  it("lastMessageId tracks the newest transcript message", () => {
    const translate = translator();
    expect(translate.lastMessageId).toBeNull();
    translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "one" }], "m-1"),
    );
    expect(translate.lastMessageId).toBe("m-1");
    // Anonymous messages fall back to the transcript line id.
    translate.onTranscriptLine({
      type: "message",
      id: "line-anon-7",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "two" }] },
    });
    expect(translate.lastMessageId).toBe("line-anon-7");
  });

  it("a resumed translator skips nextState history at or before the marker", () => {
    const translate = translatorWith({ resumeAfterMessageId: "m-2" });
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const end = translate.onFrame(
      runEnd("end_turn", [
        {
          role: "assistant",
          content: [{ type: "text", text: "old-1" }],
          meta: { messageId: "m-1", source: "model", createdAt: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "old-2" }],
          meta: { messageId: "m-2", source: "model", createdAt: 2 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "new-3" }],
          meta: { messageId: "m-3", source: "model", createdAt: 3 },
        },
      ]),
    );
    const texts = end.flatMap((event) =>
      event.type === "item.completed" ? [event.payload.item.text] : [],
    );
    expect(texts).toEqual(["new-3"]);
  });

  it("a marker absent from nextState leaves the replay alone", () => {
    const translate = translatorWith({ resumeAfterMessageId: "not-in-history" });
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const end = translate.onFrame(
      runEnd("end_turn", [
        {
          role: "assistant",
          content: [{ type: "text", text: "still-new" }],
          meta: { messageId: "m-9", source: "model", createdAt: 1 },
        },
      ]),
    );
    const texts = end.flatMap((event) =>
      event.type === "item.completed" ? [event.payload.item.text] : [],
    );
    expect(texts).toEqual(["still-new"]);
  });
});

describe("transcript messages dedupe on meta.messageId", () => {
  it("an assistant text lands once whether tailer or run_end delivers it", () => {
    const translate = translator();
    const line = transcriptMessage("assistant", [{ type: "text", text: "the answer" }], "msg-text");
    const first = translate.onTranscriptLine(line);
    const second = translate.onTranscriptLine(line);
    expect(types(first)).toEqual(["item.completed"]);
    expect(second).toEqual([]);
    // The same message inside run_end.nextState is a no-op.
    translate.onFrame(runStart());
    const end = translate.onFrame(runEnd("end_turn", [line.message]));
    expect(end.filter((event) => event.type.startsWith("item."))).toEqual([]);
  });

  it("emits reasoning for thinking blocks and skips empty text", () => {
    const translate = translator();
    const events = translate.onTranscriptLine(
      transcriptMessage(
        "assistant",
        [
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "text", text: "" },
          { type: "text", text: "answer" },
        ],
        "msg-mix",
      ),
    );
    expect(types(events)).toEqual(["item.completed", "item.completed"]);
    const [reasoning, text] = events;
    expect(reasoning?.type === "item.completed" && reasoning.payload.item.kind).toBe("reasoning");
    expect(text?.type === "item.completed" && text.payload.item.kind).toBe("assistant_message");
  });

  it("learns the session id from the transcript header", () => {
    const translate = translator();
    expect(
      translate.onTranscriptLine({
        type: "session",
        version: 3,
        id: "sess-from-header",
        timestamp: "x",
        cwd: "/tmp",
      }),
    ).toEqual([]);
    expect(translate.sessionId).toBe("sess-from-header");
  });
});

describe("unmapped", () => {
  it("keeps unknown frames and lines with their raw payload", () => {
    const translate = translator();
    const events = translate.onFrame(frame({ type: "what_is_this" }));
    expect(events[0]?.type).toBe("event.unmapped");
    expect(events[0]?.type === "event.unmapped" && events[0].raw.source).toBe("cmd.ndjson");

    const line = translate.onTranscriptLine({ type: "summary", text: "x" });
    expect(line[0]?.type === "event.unmapped" && line[0].raw.source).toBe("cmd.transcript");

    const bad: CmdFrameParseError | CmdFrame = parseFrame("not json at all");
    expect("line" in bad).toBe(true);
  });
});

describe("streaming deltas", () => {
  const delta = (event: Record<string, unknown>) => frame(event);

  it("streams a named delta onto the row its transcript block finishes", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());

    const started = translate.onFrame(
      delta({ type: "text_delta", messageId: "m-1", index: 0, delta: { text: "Hel" } }),
    );
    expect(types(started)).toEqual(["item.started", "content.delta"]);
    const itemId = started[0]?.itemId;
    expect(started[1]?.type === "content.delta" && started[1].payload.kind).toBe("text");
    expect(started[1]?.type === "content.delta" && started[1].payload.delta).toBe("Hel");

    const more = translate.onFrame(
      delta({ type: "text_delta", messageId: "m-1", index: 0, delta: { text: "lo" } }),
    );
    // The row already exists — only the delta goes out, on the same item.
    expect(types(more)).toEqual(["content.delta"]);
    expect(more[0]?.itemId).toBe(itemId);

    // The transcript's finished block lands on that same row, not a new one.
    const completed = translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "Hello" }], "m-1"),
    );
    expect(types(completed)).toEqual(["item.completed"]);
    expect(completed[0]?.itemId).toBe(itemId);
  });

  it("recognizes an anonymous stream by the text it built up", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const first = translate.onFrame(delta({ type: "message_delta", delta: { text: "one " } }));
    translate.onFrame(delta({ type: "message_delta", delta: { text: "two" } }));

    const completed = translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "one two" }], "m-9"),
    );
    expect(completed[0]?.itemId).toBe(first[0]?.itemId);
  });

  it("reads thinking and tool-input deltas as their own kinds", () => {
    const translate = translator();
    translate.onFrame(runStart());
    const thinking = translate.onFrame(
      delta({ type: "thinking_delta", messageId: "m-2", delta: { thinking: "hmm" } }),
    );
    expect(thinking[1]?.type === "content.delta" && thinking[1].payload.kind).toBe("reasoning");
    expect(thinking[0]?.type === "item.started" && thinking[0].payload.item.kind).toBe("reasoning");

    const toolInput = translate.onFrame(
      delta({ type: "input_json_delta", messageId: "m-3", delta: { partial_json: '{"a":' } }),
    );
    expect(toolInput[1]?.type === "content.delta" && toolInput[1].payload.kind).toBe("tool_input");
  });

  it("matches on the whole streamed text, not on a prefix of it", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    translate.onFrame(delta({ type: "message_delta", delta: { text: "one " } }));
    translate.onFrame(delta({ type: "message_delta", delta: { text: "two" } }));

    // "one " was a prefix on the way to "one two" — it is not a row anything
    // may still complete onto.
    const completed = translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "one " }], "m-8"),
    );
    expect(types(completed)).toEqual(["item.completed"]);
    expect(completed[0]?.type === "item.completed" && completed[0].payload.item.text).toBe("one ");
  });

  it("does not let one turn's streamed text complete the next turn's row", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const first = translate.onFrame(delta({ type: "message_delta", delta: { text: "same" } }));
    translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "same" }], "m-1"),
    );
    translate.onFrame(runEnd());

    translate.onFrame(turnStart());
    const second = translate.onFrame(delta({ type: "message_delta", delta: { text: "same" } }));
    expect(types(second)).toEqual(["item.started", "content.delta"]);
    expect(second[0]?.itemId).not.toBe(first[0]?.itemId);

    // The second turn's identical text completes its own row.
    const completed = translate.onTranscriptLine(
      transcriptMessage("assistant", [{ type: "text", text: "same" }], "m-2"),
    );
    expect(completed[0]?.itemId).toBe(second[0]?.itemId);
  });

  it("still reports a delta-shaped frame it cannot read as unmapped", () => {
    const translate = translator();
    expect(types(translate.onFrame(delta({ type: "mystery_delta", delta: {} })))).toEqual([
      "event.unmapped",
    ]);
  });
});

describe("cost", () => {
  it("sums the transcript's per-assistant costUsd into the turn's usage", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    translate.onTranscriptLine({
      ...transcriptMessage("assistant", [{ type: "text", text: "one" }], "m-1"),
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.002 },
    });
    translate.onTranscriptLine({
      ...transcriptMessage("assistant", [{ type: "text", text: "two" }], "m-2"),
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.003 },
    });

    const events = translate.onFrame(runEnd());
    const usage = events.find((event) => event.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.payload.costUsd).toBeCloseTo(0.005, 10);
  });

  it("leaves costUsd out when the transcript never priced the turn", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const events = translate.onFrame(runEnd());
    const usage = events.find((event) => event.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.payload.costUsd).toBeUndefined();
  });

  it("charges each line once and starts the next turn at zero", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const line = {
      ...transcriptMessage("assistant", [{ type: "text", text: "one" }], "m-1"),
      usage: { costUsd: 0.5 },
    };
    // The priced line reports the run's cost as soon as it lands — the
    // transcript's last flush arrives with or after run_end, so waiting for a
    // turn boundary would mean never reporting it at all.
    const priced = translate.onTranscriptLine(line);
    const pricedUsage = priced.find((event) => event.type === "usage.updated");
    expect(pricedUsage?.type === "usage.updated" && pricedUsage.payload.costUsd).toBe(0.5);

    // A resumed tailer re-reading its own file charges nothing twice, and says
    // nothing about usage either.
    expect(types(translate.onTranscriptLine(line))).toEqual([]);

    const first = translate.onFrame(runEnd());
    const firstUsage = first.find((event) => event.type === "usage.updated");
    expect(firstUsage?.type === "usage.updated" && firstUsage.payload.costUsd).toBe(0.5);

    // The next turn is the next process, and its counters start at zero.
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const second = translate.onFrame(runEnd());
    const secondUsage = second.find((event) => event.type === "usage.updated");
    expect(secondUsage?.type === "usage.updated" && secondUsage.payload.costUsd).toBeUndefined();
  });

  it("does not carry an interrupted turn's cost into the next turn", () => {
    const translate = translator();
    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    translate.onTranscriptLine({
      ...transcriptMessage("assistant", [{ type: "text", text: "one" }], "m-1"),
      usage: { costUsd: 0.4 },
    });
    // Interrupted: the turn never reaches run_end, so its cost is never
    // reported — and must not be billed to whatever runs next.
    expect(types(translate.onExit(130))).toEqual(["turn.completed"]);

    translate.onFrame(runStart());
    translate.onFrame(turnStart());
    const next = translate.onFrame(runEnd());
    const usage = next.find((event) => event.type === "usage.updated");
    expect(usage?.type === "usage.updated" && usage.payload.costUsd).toBeUndefined();
  });
});
