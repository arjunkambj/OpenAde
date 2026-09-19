import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Button } from "@OpenAde/ui/components/button";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type FontSize,
} from "@OpenAde/contracts/settings";

import { useAppAtoms } from "@/lib/app-runtime";
import { applyFontSizes } from "@/lib/font-size";
import { Add, Minus } from "@honeyicons/react";

function PxStepper({
  label,
  description,
  value,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: FontSize;
  readonly onChange: (next: FontSize) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <div
        role="group"
        aria-label={`${label} font size`}
        className="flex shrink-0 items-center gap-1"
      >
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Decrease ${label.toLowerCase()} font size`}
          disabled={value <= MIN_FONT_SIZE}
          onClick={() => onChange(value - FONT_SIZE_STEP)}
        >
          <Minus />
        </Button>
        <span aria-live="polite" className="w-16 text-center text-sm tabular-nums">
          {value} px
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Increase ${label.toLowerCase()} font size`}
          disabled={value >= MAX_FONT_SIZE}
          onClick={() => onChange(value + FONT_SIZE_STEP)}
        >
          <Add />
        </Button>
      </div>
    </div>
  );
}

/** The main and sidebar text sizes, in px. The sidebar size covers the left sidebar and the right dock. */
export function FontSizeSteppers() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });

  const settings = AsyncResult.isSuccess(result) ? result.value : null;
  const main = settings?.mainFontSize ?? DEFAULT_FONT_SIZE;
  const sidebar = settings?.sidebarFontSize ?? DEFAULT_FONT_SIZE;

  return (
    <div className="max-w-3xl">
      <h2 className="mb-2 text-sm font-medium">Font size</h2>
      <div className="flex flex-col gap-4">
        <PxStepper
          label="Main"
          description="The thread and everything outside the sidebars."
          value={main}
          onChange={(next) => {
            applyFontSizes({ main: next, sidebar });
            updateSettings({ mainFontSize: next });
          }}
        />
        <PxStepper
          label="Sidebar"
          description="The left sidebar and the right dock."
          value={sidebar}
          onChange={(next) => {
            applyFontSizes({ main, sidebar: next });
            updateSettings({ sidebarFontSize: next });
          }}
        />
      </div>
    </div>
  );
}
