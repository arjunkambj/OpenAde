/**
 * The keys for the thread settings row (`./header-controls`): plan mode, the
 * runtime-mode cycle, the model and effort pickers and the effort steps. Every
 * change goes through the row's own `onChange`, so a key does exactly what the
 * matching click does — a `thread.settings.update` in a thread, a local pick
 * on the start screen.
 *
 * Plan mode is only answered while the row offers it (`canPlan`, or already
 * planning). Its chord is Shift+Tab in the composer, and an unanswered command
 * leaves the key alone, so where plan mode is not on offer Shift+Tab moves the
 * focus as usual. A `restart`-locked knob is left alone too: its picker does
 * not open and its effort does not step.
 */

import type { Effort, RuntimeMode } from "@OpenAde/contracts/enums";
import type { ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";

import { stepEffort } from "@/lib/efforts";
import { nextRuntimeMode } from "@/lib/runtime-modes";
import { useKeybindingCommand } from "@/lib/shortcuts";

/** Answers `composer.planMode.toggle`, mounted only while plan mode is offered. */
function PlanModeKey({ onToggle }: { readonly onToggle: () => void }) {
  useKeybindingCommand("composer.planMode.toggle", onToggle);
  return null;
}

export function ThreadSettingsKeys({
  planOffered,
  planning,
  runtimeMode,
  runtimeModes,
  effort,
  efforts,
  effortLocked,
  onChange,
  onOpenModel,
  onOpenEffort,
}: {
  readonly planOffered: boolean;
  readonly planning: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModes: ReadonlyArray<RuntimeMode>;
  readonly effort: Effort;
  /** The current model's ladder; `undefined` when it states none. */
  readonly efforts: ReadonlyArray<Effort> | undefined;
  readonly effortLocked: boolean;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
  /** Opens the model picker; a no-op when it cannot open. */
  readonly onOpenModel: () => void;
  readonly onOpenEffort: () => void;
}) {
  useKeybindingCommand("composer.runtimeMode.cycle", () => {
    const next = nextRuntimeMode(runtimeMode, runtimeModes);
    if (next !== runtimeMode) {
      onChange({ runtimeMode: next });
    }
  });
  useKeybindingCommand("composer.modelPicker.open", onOpenModel);
  useKeybindingCommand("composer.effortPicker.open", onOpenEffort);
  const step = (direction: 1 | -1) => () => {
    const next = stepEffort(effort, efforts, direction);
    if (!effortLocked && next !== effort) {
      onChange({ effort: next });
    }
  };
  useKeybindingCommand("composer.effort.increase", step(1));
  useKeybindingCommand("composer.effort.decrease", step(-1));

  return planOffered ? (
    <PlanModeKey onToggle={() => onChange({ interactionMode: planning ? "default" : "plan" })} />
  ) : null;
}
