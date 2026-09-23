/**
 * The effort picker's rungs, lowest first.
 *
 * A connector reports each model's ladder in whatever order its harness prints
 * it; the picker always reads bottom to top in the contract's `EFFORT_ORDER`.
 * A model that states no ladder offers every rung.
 */

import { EFFORT_ORDER, type Effort } from "@OpenAde/contracts/enums";

export const orderEfforts = (
  efforts: ReadonlyArray<Effort> | null | undefined,
): ReadonlyArray<Effort> =>
  efforts == null ? EFFORT_ORDER : EFFORT_ORDER.filter((effort) => efforts.includes(effort));
