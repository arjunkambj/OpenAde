/**
 * The muted summary at the end of a queued-message row: what the message
 * carries besides its text. Each count wears the token its chips use in the
 * draft — `#` for file mentions, `$` for skills, `@` for plugins — then the
 * attachments. A message with none of them has no summary.
 *
 * `references` is optional on a queued message: one queued before references
 * existed has none, and neither does one sent without any.
 */

import type { QueuedMessage } from "@OpenAde/contracts/orchestration";

export const queueSummary = (message: QueuedMessage): string | null => {
  const references = message.references ?? [];
  const skills = references.filter((reference) => reference.kind === "skill").length;
  const plugins = references.length - skills;
  const parts = [
    message.mentions.length > 0 ? `#×${message.mentions.length}` : null,
    skills > 0 ? `$×${skills}` : null,
    plugins > 0 ? `@×${plugins}` : null,
    message.attachments.length > 0 ? `+${message.attachments.length} file(s)` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" ");
};
