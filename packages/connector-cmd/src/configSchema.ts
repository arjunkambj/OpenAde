/**
 * Command Code's own settings document — what `settings.connectors[].config`
 * holds for an instance of this connector. The `settingsForm` annotations are
 * the form the connectors page renders for it, served over
 * `connectors.describe`, so nothing above this package spells it out.
 */

import { NonEmptyString } from "@poseidon/contracts/base";
import { settingsForm } from "@poseidon/contracts/settings";
import * as Schema from "effect/Schema";

/**
 * Command Code's own knobs. `binaryPath` is empty until the user overrides the
 * probe, `extraEnv` is merged into the allowlisted spawn environment, and
 * `defaultModel` is what a new thread on this instance starts with when the
 * app-wide default is unset — which it is until a probe has reported models.
 */
export const CmdConnectorConfig = Schema.Struct({
  binaryPath: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Binary path",
      description: "Path to the cmd binary. Leave empty to use the discovered one.",
      control: "path",
      placeholder: "cmd",
    }),
  ),
  extraEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)).pipe(
    settingsForm({
      label: "Extra environment",
      description: "Variables added to every session this instance spawns.",
      control: "keyValue",
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
export type CmdConnectorConfig = typeof CmdConnectorConfig.Type;
