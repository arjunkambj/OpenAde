/**
 * What the runtime-mode pickers offer and call each mode.
 *
 * The labels are OpenAde's own, one table for every picker, so the header, the
 * `/mode` menu and the Models page never disagree about what a mode is called.
 * Which modes are offered is the connector's call: `capabilities.runtimeModes`
 * lists the ones its harness can honour. With no capabilities yet — a
 * connector that has not opened — every mode is offered, in contract order.
 */

import { RuntimeMode } from "@OpenAde/contracts/enums";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Ask first",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

/**
 * The modes to offer, in `RuntimeMode` order whatever order the connector
 * listed them in. An empty list is a connector bug, and a picker with nothing
 * in it would leave the thread stuck, so it reads as "not stated".
 */
export const runtimeModeOptions = (
  capabilities: Pick<ConnectorCapabilities, "runtimeModes"> | null | undefined,
): ReadonlyArray<RuntimeMode> => {
  const supported = capabilities?.runtimeModes ?? [];
  return supported.length === 0
    ? RuntimeMode.literals
    : RuntimeMode.literals.filter((mode) => supported.includes(mode));
};
