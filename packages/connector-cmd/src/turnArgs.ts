/**
 * One turn's prompt and argv.
 *
 * Print mode has no image flag, so attachments are staged under
 * `<attachmentsDir>/<threadId>/`, that directory joins the run's scope through
 * `--add-dir`, and the prompt names the absolute paths (decision W10).
 * Mentions become `@name` lines. Everything else is `buildArgs`.
 *
 * `--yolo` goes on every ordinary turn: print mode refuses writes and shell
 * without it whatever a hook answered (`fixtures/cmd/shell-allow/`), while a
 * deny still stops the call under it — recorded under this exact argv in
 * `fixtures/cmd/shell-deny-yolo/`. A plan turn is the exception and does not
 * carry it; see below.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import type { TurnInput } from "@OpenAde/connector-sdk/definition";

import { stageTurnAttachments } from "./attachments";
import { buildArgs, TOOLS_ENABLED } from "./spawn";

export interface PreparedTurn {
  readonly args: ReadonlyArray<string>;
  /** Attachment problems worth telling the user about. */
  readonly warnings: ReadonlyArray<string>;
  /** Spawned with `--permission-mode plan`. */
  readonly plan: boolean;
}

export const prepareTurn = async (input: {
  readonly turn: TurnInput;
  readonly settings: ThreadSettings;
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  /** The session to resume, or null to let the harness open a new one. */
  readonly resumeSessionId: string | null;
}): Promise<PreparedTurn> => {
  const attached = await stageTurnAttachments({
    attachmentsDir: input.attachmentsDir,
    threadId: input.threadId,
    attachments: input.turn.attachments,
  });
  const mentioned = input.turn.mentions.map((mention) => `@${mention}`);
  const prompt = [input.turn.text, ...mentioned, ...attached.promptLines]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const plan = input.settings.interactionMode === "plan";
  return {
    plan,
    warnings: attached.warnings,
    args: buildArgs({
      prompt,
      model: input.settings.model,
      ...(input.settings.effort === undefined ? {} : { effort: input.settings.effort }),
      ...(input.resumeSessionId === null ? {} : { sessionId: input.resumeSessionId }),
      // Not in plan mode. `--yolo` turns off print mode's own refusal of
      // writes and shell calls, and in plan mode PreToolUse never fires —
      // `hookCount: 0` in all four plan recordings, including one whose
      // `read_file` fires a hook in an ordinary run — so under both together
      // a mode the UI labels "Plan first" had no enforcement of any kind:
      // not the user's deny rules, not the ladder's own "plan mode is
      // read-only", not the sensitive-path prompt. Nothing but the model's
      // compliance. Without `--yolo` the CLI refuses every write and every
      // shell call itself (`fixtures/cmd/plan-no-yolo/`), which is what the
      // mode claims to be — and the plan survives, because the body of the
      // refused `write_file` is in the frame that announced it (`plans.ts`).
      yolo: !plan,
      ...(plan ? { permissionMode: "plan" as const } : {}),
      ...(attached.addDirs.length === 0 ? {} : { addDir: attached.addDirs }),
      toolsEnable: TOOLS_ENABLED,
    }),
  };
};
