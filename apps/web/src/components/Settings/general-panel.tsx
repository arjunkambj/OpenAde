/**
 * The General page: the theme cards and the main and sidebar font sizes.
 * New-thread defaults (model, effort, runtime mode) live on the Models page.
 */

import { FontSizeSteppers } from "./font-size-steppers";
import { ThemeCards } from "./theme-cards";

export function GeneralPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">General</h1>
        <p className="mt-1 text-sm text-muted-foreground">How the app looks.</p>
      </div>

      <ThemeCards />
      <FontSizeSteppers />
    </div>
  );
}
