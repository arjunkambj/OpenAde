/**
 * Claude Code's own settings document — what `settings.connectors[].config`
 * holds for an instance of this connector. The `settingsForm` annotations are
 * the form the connectors page renders for it, served over
 * `connectors.describe`, so nothing above this package spells it out.
 */

import { NonEmptyString } from "@OpenAde/contracts/base";
import { settingsForm } from "@OpenAde/contracts/settings";
import * as Schema from "effect/Schema";

/**
 * Claude Code's own knobs. `binaryPath` is empty until the user overrides the
 * probe. `configDir` points one instance at a second Claude account: the CLI
 * reads its credentials and settings from `CLAUDE_CONFIG_DIR`, and the
 * connector never moves `HOME` for that, because the macOS keychain the CLI
 * signs in through is found under `HOME`. `defaultModel` is what a new thread
 * on this instance starts with when the app-wide default is unset.
 */
export const ClaudeConnectorConfig = Schema.Struct({
  binaryPath: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Binary path",
      description: "Path to the claude binary. Leave empty to use the discovered one.",
      control: "path",
      placeholder: "claude",
    }),
  ),
  configDir: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Config directory",
      description:
        "CLAUDE_CONFIG_DIR — a separate Claude account for this instance. Leave empty to use ~/.claude. HOME is never changed.",
      control: "path",
      placeholder: "~/.claude",
    }),
  ),
  defaultModel: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Default model",
      description: "Model new threads on this instance start with.",
      control: "select",
    }),
  ),
});
export type ClaudeConnectorConfig = typeof ClaudeConnectorConfig.Type;
