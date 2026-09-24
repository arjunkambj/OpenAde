/**
 * How full the model's context window is: a small ring and the percentage,
 * with the token counts in its tooltip. `used` is the thread's last reported
 * usage; a thread that has not run yet passes 0 against the model's window,
 * so the meter is there from the first message rather than appearing after it.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { cn } from "@poseidon/ui/lib/utils";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** From here on the ring turns destructive: compaction is close. */
const NEARLY_FULL = 0.8;

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function ContextMeter({
  used,
  limit,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly className?: string;
}) {
  const fraction = Math.min(1, used / Math.max(1, limit));
  const percent = Math.round(fraction * 100);
  const full = fraction >= NEARLY_FULL;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground tabular-nums",
              className,
            )}
            aria-label={`Context window ${percent}% used`}
          />
        }
      >
        <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            className={full ? "stroke-destructive" : "stroke-foreground/85"}
          />
        </svg>
        {percent}%
      </TooltipTrigger>
      <TooltipContent>
        Context window: {tokens.format(used)} of {tokens.format(limit)} tokens used
      </TooltipContent>
    </Tooltip>
  );
}
