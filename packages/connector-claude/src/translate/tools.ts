/**
 * A session's tool calls as timeline rows.
 *
 * The SDK tells a tool call twice. The model's `tool_use` block arrives in an
 * `assistant` snapshot, whole, with its id, name and input; the call's
 * `tool_result` block arrives later in a `user` message the CLI writes, with
 * the text the model is shown and, beside it, `tool_use_result`: the tool's
 * own structured output (an edit's patch, a write's `create`/`update`). The
 * `tool_use` id keys the row, so the result settles the row the call opened.
 *
 * How each tool reads:
 *
 * | Tool                                   | Row                                        |
 * | -------------------------------------- | ------------------------------------------ |
 * | Bash                                   | `command_execution`: command, output, exit |
 * | Edit, MultiEdit, NotebookEdit          | `file_change` edit, diff from the patch    |
 * | Write                                  | `file_change` create or edit, and its diff |
 * | Read, Glob, Grep, LS                   | `tool_call`                                |
 * | WebFetch, WebSearch                    | `web_search`                               |
 * | `mcp__<server>__<tool>`                | `mcp_tool_call`, naming the server         |
 * | TodoWrite                              | `todo`, the model's checklist              |
 * | Skill                                  | `skill`                                    |
 * | Task, Agent                            | `task`                                     |
 * | ExitPlanMode, EnterPlanMode            | `plan`                                     |
 * | anything else, AskUserQuestion among   | `tool_call`                                |
 * | them                                   |                                            |
 *
 * An ExitPlanMode call is how a plan turn hands its plan over, and the
 * session answers it before the CLI runs it: `planProposed` settles the row
 * with the plan's markdown, and the refusal the CLI then writes back as the
 * call's result leaves that row as it is. EnterPlanMode — the model putting
 * itself in plan mode — settles as a plan row with the CLI's own line.
 *
 * A result marked `is_error` fails the row — a refused call is one: the CLI
 * tells the model the refusal as the call's error result. A finished row is
 * never put back to running, nor finished twice. Output is cut at
 * `MAX_TOOL_OUTPUT_CHARS`, as Command Code's is, so one build log cannot swell
 * the event log.
 */

import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import { makeItemId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot, Todo } from "@OpenAde/contracts/runtime";

import { mcpToolFor } from "../approvals";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type Json,
  type PendingRuntimeEvent,
} from "./pending";

/** 64KB of a tool's output: a useful head, and the cut marked. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

export const truncateToolOutput = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]`
    : text;

const TOOL_KIND: Readonly<Record<string, ItemKind>> = {
  Bash: "command_execution",
  Edit: "file_change",
  MultiEdit: "file_change",
  NotebookEdit: "file_change",
  Write: "file_change",
  Read: "tool_call",
  Glob: "tool_call",
  Grep: "tool_call",
  LS: "tool_call",
  WebFetch: "web_search",
  WebSearch: "web_search",
  TodoWrite: "todo",
  Skill: "skill",
  Task: "task",
  Agent: "task",
  ExitPlanMode: "plan",
  EnterPlanMode: "plan",
};

/** The row kind a tool's calls are drawn as. */
export const kindForTool = (name: string): ItemKind =>
  mcpToolFor(name) !== undefined ? "mcp_tool_call" : (TOOL_KIND[name] ?? "tool_call");

/**
 * TodoWrite's list as the contract's todos. The CLI's entries carry no id; an
 * entry's place in the list is its id, which holds while the model ticks the
 * list off, since it rewrites the whole list in the same order each time.
 */
export const todosOf = (input: Json): ReadonlyArray<Todo> =>
  asArray(input.todos).flatMap((entry, index): Array<Todo> => {
    const todo = asRecord(entry);
    const text = asString(todo.content) ?? asString(todo.text);
    if (text === undefined || text.trim() === "") return [];
    const status = asString(todo.status);
    return [
      {
        todoId: `todo-${index}`,
        text,
        status: status === "in_progress" || status === "completed" ? status : "pending",
      },
    ];
  });

/** The text of a `tool_result`'s content: a string, or its text blocks joined. */
export const textOfToolResult = (content: unknown): string =>
  typeof content === "string"
    ? content
    : asArray(content)
        .flatMap((block) => {
          const text = asString(asRecord(block).text);
          return text === undefined ? [] : [text];
        })
        .join("\n");

/** The CLI's own first line for a command that exited non-zero. */
const exitCodeOf = (text: string): number | undefined => {
  const match = /^Exit code (\d+)/.exec(text);
  return match === null ? undefined : Number(match[1]);
};

/**
 * A unified diff from the tool's structured patch — `structuredPatch` hunks
 * for Edit, MultiEdit and a Write over an existing file — or, for a Write
 * that created the file, from its content. Absent when the tool said neither.
 */
export const diffOf = (path: string, structured: Json): string | undefined => {
  const hunks = asArray(structured.structuredPatch).map(asRecord);
  const created = structured.type === "create";
  const header = [`--- ${created ? "/dev/null" : path}`, `+++ ${path}`];
  if (hunks.length > 0) {
    return truncateToolOutput(
      [
        ...header,
        ...hunks.flatMap((hunk) => [
          `@@ -${asNumber(hunk.oldStart) ?? 0},${asNumber(hunk.oldLines) ?? 0} +${asNumber(hunk.newStart) ?? 0},${asNumber(hunk.newLines) ?? 0} @@`,
          ...asArray(hunk.lines).flatMap((line) => (typeof line === "string" ? [line] : [])),
        ]),
      ].join("\n"),
    );
  }
  const content = asString(structured.content);
  if (!created || content === undefined || content === "") return undefined;
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return truncateToolOutput(
    [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
  );
};

/** The row a call opens, from its name and input. */
const snapshotFor = (itemId: ItemId, name: string, input: Json): ItemSnapshot => {
  const kind = kindForTool(name);
  const base: ItemSnapshot = { itemId, kind, status: "in_progress" };
  const described = asString(input.description);
  switch (kind) {
    case "command_execution":
      return {
        ...base,
        ...(described === undefined || described === "" ? {} : { text: described }),
        command: { cmd: asString(input.command) || name },
      };
    case "file_change": {
      const path =
        asString(input.file_path) || asString(input.notebook_path) || asString(input.path) || name;
      return {
        ...base,
        // A Write reads as a create until its result says it replaced a file.
        fileChange: { path, kind: name === "Write" ? "create" : "edit" },
        tool: { name, input },
      };
    }
    case "todo":
      return { ...base, todos: [...todosOf(input)], tool: { name, input } };
    case "mcp_tool_call": {
      const server = mcpToolFor(name)?.server;
      return { ...base, tool: { name, ...(server === undefined ? {} : { server }), input } };
    }
    case "task":
      return {
        ...base,
        ...(described === undefined || described === "" ? {} : { text: described }),
        tool: { name, input },
      };
    case "plan": {
      const plan = asString(input.plan)?.trim() ?? "";
      return { ...base, ...(plan === "" ? {} : { text: plan }), tool: { name, input } };
    }
    case "skill": {
      const skill = asString(input.skill) ?? asString(input.command);
      return {
        ...base,
        ...(skill === undefined || skill === "" ? {} : { text: skill }),
        tool: { name, input },
      };
    }
    default:
      return { ...base, tool: { name, input } };
  }
};

interface Row {
  readonly name: string;
  snapshot: ItemSnapshot;
}

export interface ToolRows {
  /** A `tool_use` block from an `assistant` snapshot → the row opens. */
  readonly started: (block: Json) => ReadonlyArray<PendingRuntimeEvent>;
  /**
   * A `tool_result` block, with the message's `tool_use_result` when the
   * message carried this one result → the row settles.
   */
  readonly finished: (block: Json, structured: unknown) => ReadonlyArray<PendingRuntimeEvent>;
  /**
   * The plan an ExitPlanMode call handed over → its row, settled with the
   * markdown. The call's own `tool_use` may not have been read yet; the row
   * it would open is this one.
   */
  readonly planProposed: (
    toolUseId: string | undefined,
    markdown: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** Fails every row still open, saying why — the turn ended under them. */
  readonly abandonOpen: (reason: string) => ReadonlyArray<PendingRuntimeEvent>;
  /** How many calls have finished without an error: the calls that ran. */
  readonly ran: () => number;
}

export const makeToolRows = (): ToolRows => {
  const rows = new Map<string, Row>();
  let ran = 0;

  const started = (block: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const id = asString(block.id) ?? `anonymous:${makeItemId()}`;
    if (rows.has(id)) return [];
    const name = asString(block.name) || "tool";
    const snapshot = snapshotFor(makeItemId(), name, asRecord(block.input));
    rows.set(id, { name, snapshot });
    return [{ itemId: snapshot.itemId, type: "item.started", payload: { item: snapshot } }];
  };

  const finished = (block: Json, structured: unknown): ReadonlyArray<PendingRuntimeEvent> => {
    const id = asString(block.tool_use_id);
    const known = id === undefined ? undefined : rows.get(id);
    if (known !== undefined && known.snapshot.status !== "in_progress") return [];
    const row: Row = known ?? {
      name: "tool",
      snapshot: { itemId: makeItemId(), kind: "tool_call", status: "in_progress" },
    };
    const failed = block.is_error === true;
    const output = truncateToolOutput(textOfToolResult(block.content));
    const prior = row.snapshot;
    const exitCode = failed ? exitCodeOf(output) : undefined;
    const detail = asRecord(structured);
    const diff =
      prior.fileChange === undefined || failed ? undefined : diffOf(prior.fileChange.path, detail);
    const snapshot: ItemSnapshot = {
      ...prior,
      status: failed ? "failed" : "completed",
      // A command's output is the command's; every other row keeps it on its tool.
      ...(prior.command === undefined
        ? { tool: { ...(prior.tool ?? { name: row.name, input: {} }), output } }
        : {
            command: { ...prior.command, output, ...(exitCode === undefined ? {} : { exitCode }) },
          }),
      ...(prior.fileChange === undefined || failed
        ? {}
        : {
            fileChange: {
              ...prior.fileChange,
              ...(detail.type === "update" ? { kind: "edit" as const } : {}),
              ...(diff === undefined ? {} : { diff }),
            },
          }),
      ...(failed ? { error: { message: output === "" ? "The tool call failed." : output } } : {}),
      // A plan row reads its text; one with no plan of its own shows the CLI's line.
      ...(prior.kind === "plan" && prior.text === undefined && !failed && output !== ""
        ? { text: output }
        : {}),
    };
    row.snapshot = snapshot;
    if (id !== undefined) rows.set(id, row);
    if (!failed) ran += 1;
    return [{ itemId: snapshot.itemId, type: "item.completed", payload: { item: snapshot } }];
  };

  const planProposed = (
    toolUseId: string | undefined,
    markdown: string,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const id = toolUseId ?? `anonymous:${makeItemId()}`;
    const known = rows.get(id);
    const snapshot: ItemSnapshot = {
      ...(known?.snapshot ?? { itemId: makeItemId(), kind: "plan" }),
      kind: "plan",
      status: "completed",
      text: markdown,
    };
    rows.set(id, { name: known?.name ?? "ExitPlanMode", snapshot });
    return [{ itemId: snapshot.itemId, type: "item.completed", payload: { item: snapshot } }];
  };

  const abandonOpen = (reason: string): ReadonlyArray<PendingRuntimeEvent> => {
    const events: Array<PendingRuntimeEvent> = [];
    for (const row of rows.values()) {
      if (row.snapshot.status !== "in_progress") continue;
      row.snapshot = { ...row.snapshot, status: "failed", error: { message: reason } };
      events.push({
        itemId: row.snapshot.itemId,
        type: "item.completed",
        payload: { item: row.snapshot },
      });
    }
    return events;
  };

  return { started, finished, planProposed, abandonOpen, ran: () => ran };
};
