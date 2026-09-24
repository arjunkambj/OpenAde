import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextMeter } from "@/components/composer/context-meter";

const meter = (used: number, limit: number) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ContextMeter used={used} limit={limit} />
    </TooltipProvider>,
  );

describe("ContextMeter", () => {
  it("reads the share of the window used, rounded", () => {
    const markup = meter(24_600, 200_000);
    expect(markup).toContain('aria-label="Context window 12% used"');
    expect(markup).toContain("12%");
  });

  it("reads 0% before a turn has reported any usage", () => {
    expect(meter(0, 200_000)).toContain("0%");
  });

  it("turns destructive once the window is nearly full, and caps at 100%", () => {
    expect(meter(150_000, 200_000)).not.toContain("stroke-destructive");
    expect(meter(170_000, 200_000)).toContain("stroke-destructive");
    expect(meter(250_000, 200_000)).toContain("100%");
  });
});
