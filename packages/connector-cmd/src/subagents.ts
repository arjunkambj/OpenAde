/**
 * What a delegated subagent is doing, as one line of progress.
 *
 * The harness reports a delegation through a family of its own —
 * `subagent_start`, `subagent_progress`, `subagent_stop` — all of them carrying
 * the `toolCallId` of the `agent` call that spawned it (`fixtures/cmd/subagent/`).
 * They are progress on that one `task` row, which `tool_completed` finally
 * replaces with the subagent's answer.
 *
 * Why they matter more than their size suggests: **the subagent's own tool calls
 * are not gated**. PreToolUse fires once, for the delegation, and never again —
 * so approving an `agent` call approves everything it goes on to do, and
 * `subagent_progress` is the only trace of what that was. Dropping these frames
 * leaves the row silent for the whole delegation.
 *
 * Recorded in `fixtures/cmd/subagent/` and written up in
 * `docs/command-code-connector.md`, "Subagents".
 */

import { asOptionalString, asString } from "./items";

/** The frame fields this module reads; everything else stays on the frame. */
type SubagentFrame = { readonly [key: string]: unknown };

/**
 * What to call it. The harness names a kind (`general` in the recording); an
 * unnamed one is still worth a word.
 */
const label = (event: SubagentFrame): string => {
  const type = asOptionalString(event.subagentType);
  return type === undefined ? "subagent" : `${type} subagent`;
};

/**
 * One progress line for one subagent frame, or `null` for a frame this does not
 * handle. Each line replaces the last, so the row reads as a status: what was
 * delegated, what the subagent is reaching for now, then what it cost.
 */
export const subagentProgress = (event: SubagentFrame): string | null => {
  switch (event.type) {
    case "subagent_start": {
      const description = asOptionalString(event.description);
      return `${label(event)} started${description === undefined ? "" : `: ${description}`}`;
    }
    case "subagent_progress": {
      const tool = asOptionalString(event.toolName);
      if (tool === undefined) {
        return `${label(event)} working`;
      }
      // `toolInput` is a bare string for a one-argument tool and an object
      // otherwise; both have to read as one line beside the tool's name.
      const input = asString(event.toolInput) ?? JSON.stringify(event.toolInput ?? {});
      return `${label(event)}: ${tool} ${input}`.trimEnd();
    }
    case "subagent_stop": {
      const tokens = typeof event.tokensUsed === "number" ? event.tokensUsed : undefined;
      return `${label(event)} finished${tokens === undefined ? "" : ` (${tokens} tokens)`}`;
    }
    default: {
      return null;
    }
  }
};
