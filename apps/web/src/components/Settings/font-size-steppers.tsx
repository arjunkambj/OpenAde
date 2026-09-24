import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type FontSize,
} from "@poseidon/contracts/settings";

import { useFontSizes } from "@/lib/use-font-sizes";
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={`Decrease ${label.toLowerCase()} font size`}
                disabled={value <= MIN_FONT_SIZE}
                onClick={() => onChange(value - FONT_SIZE_STEP)}
              />
            }
          >
            <Minus variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Smaller</TooltipContent>
        </Tooltip>
        <span aria-live="polite" className="w-16 text-center text-sm tabular-nums">
          {value} px
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={`Increase ${label.toLowerCase()} font size`}
                disabled={value >= MAX_FONT_SIZE}
                onClick={() => onChange(value + FONT_SIZE_STEP)}
              />
            }
          >
            <Add variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Larger</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The main and sidebar text sizes, in px. The sidebar size covers the left
 * sidebar and the right dock. The `font.*` keys step both through the same
 * `useFontSizes`, so these read the new value as soon as the settings do.
 */
export function FontSizeSteppers() {
  const { sizes, setSizes } = useFontSizes();
  const main = sizes?.main ?? DEFAULT_FONT_SIZE;
  const sidebar = sizes?.sidebar ?? DEFAULT_FONT_SIZE;

  return (
    <div className="max-w-3xl">
      <h2 className="mb-2 text-sm font-medium">Font size</h2>
      <div className="flex flex-col gap-4">
        <PxStepper
          label="Main"
          description="The thread and everything outside the sidebars."
          value={main}
          onChange={(next) => setSizes({ main: next, sidebar })}
        />
        <PxStepper
          label="Sidebar"
          description="The left sidebar and the right dock."
          value={sidebar}
          onChange={(next) => setSizes({ main, sidebar: next })}
        />
      </div>
    </div>
  );
}
