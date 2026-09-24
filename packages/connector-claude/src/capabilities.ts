/**
 * What a Claude Code session can do, as the engine and the renderer read it.
 *
 * Its own module because the definition, the probe and the session all need
 * it. A value here is a promise the session keeps; the ones no recording
 * backs yet say so, and stay at the answer that promises least.
 */

import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

export const CLAUDE_CAPABILITIES: ConnectorCapabilities = {
  // One process serves the whole session, and the SDK's `setModel` changes
  // the model for the next request without restarting it.
  modelSwitch: "in-session",
  // The SDK's `applyFlagSettings({ effortLevel })` sets the effort mid-session.
  // Not yet shown by a recording; until one does, the header says the change
  // lands on the next turn, which is true either way.
  effortSwitch: "per-turn",
  // The SDK can push a second user message into a running turn, but the
  // session does not do it yet: until it does, a message sent mid-turn queues.
  steering: false,
  // Permission mode `plan`, with the plan handed over through ExitPlanMode
  // and raised as the plan card (`interactions.ts`). `plan-accept` is the
  // recording that will show it; none is made yet.
  planMode: true,
  // The Task tool and its task_* system messages.
  subagents: true,
  // Native image content blocks in the user message.
  images: true,
  // `resume: <sessionId>` against the CLI's own transcript.
  resume: true,
  // Nothing recorded forks a session yet.
  fork: false,
  // `Query.interrupt()` stops the running request inside the one long-lived
  // process; nothing recorded yet shows what it leaves behind.
  interrupt: "session",
  // `resumeSessionAt` can rewind the CLI's conversation, but nothing recorded
  // shows it yet. OpenAde's checkpoints are git and do not depend on it.
  rollback: false,
  // A `/compact` user message asks the CLI to compact its context.
  compaction: true,
  // AskUserQuestion, answered through the question card as the tool's
  // result. The CLI offers the tool to SDK sessions (recorded `system/init`);
  // `question` is the recording that will show a card answered.
  questions: true,
  // Every mode is enforced by OpenAde's permission ladder through the session's
  // PreToolUse hook, which runs for every tool call in every permission mode.
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Files go under the thread's attachments directory, which the session adds
  // to the CLI's readable directories, and are named in the prompt.
  attachments: "files",
};
