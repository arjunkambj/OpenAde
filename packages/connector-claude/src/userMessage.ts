/**
 * One composer turn as the user message the CLI reads.
 *
 * The text goes first, then each mention as the CLI's own `@path` form, then
 * one line per attachment named by path (`attachments.ts`). Images are not
 * lines: they travel as image content blocks ahead of the text. The text goes
 * last on purpose — the CLI reads a message as a slash command only when its
 * last block is text — so `/compact` with a screenshot is still the command;
 * and a turn with no images is sent as a plain string, the form the CLI reads
 * `/compact` from on its own.
 *
 * The uuid is ours: the CLI echoes it on the `result` that answers the
 * message, which is how a result is tied to the message it ends.
 */

import * as NodeCrypto from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnInput } from "@OpenAde/connector-sdk/definition";

import type { StagedAttachments } from "./attachments";

const NONE: Pick<StagedAttachments, "images" | "promptLines"> = { images: [], promptLines: [] };

const promptText = (
  turn: TurnInput,
  staged: Pick<StagedAttachments, "promptLines"> = NONE,
): string =>
  [turn.text, ...turn.mentions.map((mention) => `@${mention}`), ...staged.promptLines]
    .filter((line) => line !== "")
    .join("\n");

export const userMessage = (
  turn: TurnInput,
  staged: Pick<StagedAttachments, "images" | "promptLines"> = NONE,
): SDKUserMessage => {
  const text = promptText(turn, staged);
  return {
    type: "user",
    message: {
      role: "user",
      content:
        staged.images.length === 0
          ? text
          : [...staged.images, ...(text === "" ? [] : [{ type: "text" as const, text }])],
    },
    parent_tool_use_id: null,
    uuid: NodeCrypto.randomUUID(),
  };
};
