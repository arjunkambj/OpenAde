/**
 * One composer turn as the user message the CLI reads.
 *
 * The text goes first, then each mention as the CLI's own `@path` form, then
 * one line per attachment naming its absolute path and media type. The server
 * stages an upload into the thread's attachments directory, which the session
 * makes readable to the CLI (`queryOptions.ts`), so the model reads the file
 * by that path. The uuid is ours: the CLI echoes it on the `result` that
 * answers the message, which is how a result is tied to the message it ends.
 */

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnInput } from "@OpenAde/connector-sdk/definition";

const attachmentLine = (attachment: TurnInput["attachments"][number]): string => {
  const path = NodePath.resolve(attachment.path);
  return attachment.mime === undefined
    ? `Attachment: ${path}`
    : `Attachment (${attachment.mime}): ${path}`;
};

export const promptText = (turn: TurnInput): string =>
  [
    turn.text,
    ...turn.mentions.map((mention) => `@${mention}`),
    ...turn.attachments.map(attachmentLine),
  ]
    .filter((line) => line !== "")
    .join("\n");

export const userMessage = (turn: TurnInput): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: promptText(turn) },
  parent_tool_use_id: null,
  uuid: NodeCrypto.randomUUID(),
});
