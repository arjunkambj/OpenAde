/**
 * The Appearance font sizes, read from and written to the settings document.
 * The Settings steppers and the `font.*` keys both go through here, so a key
 * press and a click land the same way: the scales are applied to the page at
 * once (`applyFontSizes`, which also mirrors them for the next first paint) and
 * the patch persists both sizes.
 *
 * `sizes` is null until the settings document has loaded — stepping from a
 * guessed default would overwrite whatever the user stored.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useAppAtoms } from "@/lib/app-runtime";
import { applyFontSizes, type FontSizes } from "@/lib/font-size";

export function useFontSizes(): {
  readonly sizes: FontSizes | null;
  readonly setSizes: (next: FontSizes) => void;
} {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });

  const settings = AsyncResult.isSuccess(result) ? result.value : null;
  const main = settings?.mainFontSize ?? null;
  const sidebar = settings?.sidebarFontSize ?? null;
  const sizes = React.useMemo(
    () => (main === null || sidebar === null ? null : { main, sidebar }),
    [main, sidebar],
  );

  const setSizes = React.useCallback(
    (next: FontSizes) => {
      applyFontSizes(next);
      updateSettings({ mainFontSize: next.main, sidebarFontSize: next.sidebar });
    },
    [updateSettings],
  );

  return { sizes, setSizes };
}
