/**
 * SDK messages → `RuntimeEvent`s, one session's worth.
 *
 * One translator lives as long as its session, because what it has to
 * remember crosses messages: which stream rows a snapshot finishes
 * (`textRows.ts`), the model the CLI reported, how full the context was after
 * the last request, and the running cost total a result is measured against.
 *
 * What it maps:
 *
 * - `stream_event` text and thinking deltas → `content.delta` on rows the
 *   block starts open;
 * - `assistant` snapshots → the finished `assistant_message` and `reasoning`
 *   rows. A snapshot the CLI wrote in place of an answer because the request
 *   failed — it carries `error`, and the text is the CLI's own line, such as
 *   "Not logged in · Please run /login" — becomes a `runtime.error` instead,
 *   fatal and naming the login command when the failure is the sign-in;
 * - the `tool_use` blocks of those snapshots, and the `tool_result`s the CLI
 *   writes back as `user` messages → one row per call (`tools.ts`), opened by
 *   the call and settled by its result. Rows a turn leaves open when its
 *   `result` arrives are failed there, so none spins under an idle thread;
 * - `system/init` → `mcp.status.updated`, and the model it reports is kept for
 *   the context window. It is not reported as `model.changed`: the CLI names
 *   the model a choice resolved to (`default` runs as a dated id), and the
 *   thread keeps the id the user picked;
 * - `result` → `usage.updated`, `context.updated` and `turn.completed`
 *   (`result.ts`);
 * - a `system/status` that only reports the CLI's permission mode → nothing;
 *   the session reads the mode off it (`isModeReport`);
 * - `command_lifecycle` and `system/status: requesting` → nothing, on purpose.
 *   The first is the CLI's receipt for each user message the session wrote
 *   (queued, started, cancelled); the session already knows its turn from
 *   what it sent and from the `result` that ends it. The second says a request
 *   is on its way to the API, which the deltas that follow say again.
 *
 * Everything else — subagent traffic, a user message that is not tool
 * results, status and lifecycle notices — is kept whole as `event.unmapped`
 * until a mapping exists
 * for it. Nothing is dropped silently; the stream events skipped here are the
 * block boundaries and message-level bookkeeping the snapshot restates.
 */

import type { McpServerStatus } from "@OpenAde/contracts/runtime";

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  tokens,
  unmapped,
  type Json,
  type PendingRuntimeEvent,
} from "./pending";
import { resultEvents, type TurnContext } from "./result";
import { makeTextRows } from "./textRows";
import { makeToolRows } from "./tools";

export type { TurnContext };

/** Stream events that carry nothing the snapshot will not restate. */
const RESTATED_STREAM_EVENTS = new Set([
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

/** `system/status` values that only say a request is under way. */
const REQUEST_STATUSES = new Set(["requesting"]);

/**
 * A `system/status` with no status but a `permissionMode`: the CLI saying
 * which permission mode it is in now. The session keeps that for itself
 * (`session.ts`); the thread's modes are OpenAde's, so nothing is shown.
 */
export const isModeReport = (message: Json): boolean =>
  (message.status === null || message.status === undefined) &&
  asString(message.permissionMode) !== undefined;

/** How the CLI's MCP server states read in the contract's vocabulary. */
const MCP_STATUS: Readonly<Record<string, McpServerStatus>> = {
  connected: "connected",
  pending: "connecting",
  failed: "failed",
  "needs-auth": "failed",
  disabled: "disabled",
};

export interface Translator {
  readonly translate: (
    message: unknown,
    turn: TurnContext | null,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** The newest main-loop assistant message, a point `resumeSessionAt` can rewind to. */
  readonly lastAssistantUuid: () => string | undefined;
  /** The newest `total_cost_usd`, for the session ref. */
  readonly totalCost: () => number | null;
  /** How many tool calls have run to a result that is not an error, so far. */
  readonly toolCallsRan: () => number;
  /** The plan an ExitPlanMode call handed over, settled on its row. */
  readonly planProposed: (
    toolUseId: string | undefined,
    markdown: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
}

/** Why a tool row still open at the end of its turn is failed. */
export const TURN_ENDED_UNDER_TOOL = "The turn ended before this tool call finished.";

export const makeTranslator = (options: {
  /** What the user types to sign the CLI in — named when a request fails on it. */
  readonly loginCommand: string;
  /** 0 for a fresh session, the ref's saved total for a resumed one. */
  readonly previousTotalCost: number | null;
}): Translator => {
  const rows = makeTextRows();
  const tools = makeToolRows();
  let streamMessage: string | null = null;
  let model: string | null = null;
  let contextUsed: number | null = null;
  let contextLimit: number | null = null;
  let totalCost = options.previousTotalCost;
  let errorReported = false;
  let lastAssistantUuid: string | undefined;

  const streamEvent = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const event = asRecord(message.event);
    const type = asString(event.type);
    const index = asNumber(event.index) ?? 0;
    switch (type) {
      case "message_start": {
        streamMessage = asString(asRecord(event.message).id) ?? null;
        return [];
      }
      case "content_block_start": {
        const block = asString(asRecord(event.content_block).type);
        if (streamMessage === null) return [];
        if (block === "text") return rows.open(streamMessage, index, "assistant_message");
        if (block === "thinking") return rows.open(streamMessage, index, "reasoning");
        // Tool-use and other blocks are told by the snapshot that follows.
        return [];
      }
      case "content_block_delta": {
        const delta = asRecord(event.delta);
        if (streamMessage === null) return [];
        if (delta.type === "text_delta") {
          return rows.delta(streamMessage, index, asString(delta.text) ?? "");
        }
        if (delta.type === "thinking_delta") {
          return rows.delta(streamMessage, index, asString(delta.thinking) ?? "");
        }
        // Tool input and thinking signatures arrive whole in the snapshot.
        return [];
      }
      default:
        return type !== undefined && RESTATED_STREAM_EVENTS.has(type) ? [] : [unmapped(message)];
    }
  };

  const failedRequest = (message: Json, error: string): ReadonlyArray<PendingRuntimeEvent> => {
    errorReported = true;
    const said = asArray(asRecord(message.message).content)
      .flatMap((block) => {
        const text = asString(asRecord(block).text);
        return text === undefined ? [] : [text];
      })
      .join("\n")
      .trim();
    const text =
      error === "authentication_failed"
        ? `Claude Code is not signed in. Run \`${options.loginCommand}\` in a terminal, then send the message again.`
        : said === ""
          ? `Claude Code request failed: ${error}`
          : said;
    // Signed out is fatal, as Command Code's exit 3 is: nothing the thread
    // sends will work until the user signs in, and only a fatal error is a
    // row on the timeline. A failed request is the turn failing, and the next
    // message may well work.
    return [
      {
        type: "runtime.error",
        payload: { message: text, fatal: error === "authentication_failed" },
      },
    ];
  };

  const assistant = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const error = asString(message.error);
    if (error !== undefined) return failedRequest(message, error);
    lastAssistantUuid = asString(message.uuid) ?? lastAssistantUuid;
    const body = asRecord(message.message);
    const messageId = asString(body.id) ?? asString(message.uuid) ?? "";
    const reported = asRecord(message.context_usage);
    const usage = asRecord(body.usage);
    const used =
      asNumber(reported.total_tokens) ??
      tokens(usage.input_tokens) +
        tokens(usage.cache_read_input_tokens) +
        tokens(usage.cache_creation_input_tokens) +
        tokens(usage.output_tokens);
    if (used > 0) contextUsed = used;
    const limit = asNumber(reported.raw_max_tokens);
    if (limit !== undefined && limit > 0) contextLimit = limit;

    const events: Array<PendingRuntimeEvent> = [];
    let untold = false;
    for (const entry of asArray(body.content)) {
      const block = asRecord(entry);
      if (block.type === "text") {
        events.push(...rows.settle(messageId, "assistant_message", asString(block.text) ?? ""));
      } else if (block.type === "thinking") {
        const thinking = asString(block.thinking) ?? "";
        if (thinking !== "") events.push(...rows.settle(messageId, "reasoning", thinking));
      } else if (block.type === "tool_use") {
        events.push(...tools.started(block));
      } else {
        untold = true;
      }
    }
    if (untold) events.push(unmapped(message));
    return events;
  };

  /**
   * A user message the CLI wrote: the results of the calls the model made.
   * `tool_use_result` is the tool's structured output, and belongs to the
   * message's one result — a message carrying several is read without it.
   */
  const user = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const blocks = asArray(asRecord(message.message).content).map(asRecord);
    const results = blocks.filter((block) => block.type === "tool_result");
    if (results.length === 0 || results.length !== blocks.length) return [unmapped(message)];
    const structured = results.length === 1 ? message.tool_use_result : undefined;
    return results.flatMap((block) => tools.finished(block, structured));
  };

  const init = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    model = asString(message.model) ?? model;
    const servers = asArray(message.mcp_servers).flatMap((entry) => {
      const server = asRecord(entry);
      const name = asString(server.name);
      if (name === undefined || name === "") return [];
      return [{ name, status: MCP_STATUS[asString(server.status) ?? ""] ?? "failed" }];
    });
    return [{ type: "mcp.status.updated", payload: { servers } }];
  };

  const translate = (
    raw: unknown,
    turn: TurnContext | null,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const message = asRecord(raw);
    const mainLoop =
      message.parent_tool_use_id === null || message.parent_tool_use_id === undefined;
    switch (message.type) {
      case "stream_event":
        return mainLoop ? streamEvent(message) : [unmapped(message)];
      case "assistant":
        return mainLoop ? assistant(message) : [unmapped(message)];
      case "user":
        return mainLoop ? user(message) : [unmapped(message)];
      case "system":
        if (message.subtype === "init") return init(message);
        if (message.subtype === "status" && REQUEST_STATUSES.has(asString(message.status) ?? "")) {
          return [];
        }
        if (message.subtype === "status" && isModeReport(message)) return [];
        return [unmapped(message)];
      case "command_lifecycle":
        return [];
      case "result": {
        const { events, totalCost: total } = resultEvents(message, turn, {
          previousTotalCost: totalCost,
          contextUsed,
          contextLimit,
          model,
          errorReported,
        });
        if (total !== null) totalCost = total;
        errorReported = false;
        return [...tools.abandonOpen(TURN_ENDED_UNDER_TOOL), ...events];
      }
      default:
        return [unmapped(message)];
    }
  };

  return {
    translate,
    lastAssistantUuid: () => lastAssistantUuid,
    totalCost: () => totalCost,
    toolCallsRan: tools.ran,
    planProposed: tools.planProposed,
  };
};
