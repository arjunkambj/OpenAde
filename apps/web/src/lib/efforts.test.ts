import { EFFORT_ORDER } from "@OpenAde/contracts/enums";
import { describe, expect, it } from "vitest";

import { orderEfforts } from "./efforts";

describe("orderEfforts", () => {
  it("offers the whole ladder when the model states none", () => {
    expect(orderEfforts(undefined)).toEqual(EFFORT_ORDER);
    expect(orderEfforts(null)).toEqual(EFFORT_ORDER);
  });

  it("orders a model's rungs by the canonical ladder", () => {
    expect(orderEfforts(["max", "low", "high"])).toEqual(["low", "high", "max"]);
  });

  it("drops duplicates rather than listing a rung twice", () => {
    expect(orderEfforts(["medium", "medium", "minimal"])).toEqual(["minimal", "medium"]);
  });
});
