import { RuntimeMode } from "@OpenAde/contracts/enums";
import { describe, expect, it } from "vitest";

import { RUNTIME_MODE_LABELS, runtimeModeOptions } from "./runtime-modes";

describe("runtimeModeOptions", () => {
  it("offers every mode before a connector has said what it supports", () => {
    expect(runtimeModeOptions(null)).toEqual(RuntimeMode.literals);
    expect(runtimeModeOptions(undefined)).toEqual(RuntimeMode.literals);
  });

  it("offers only the modes the connector declares, in contract order", () => {
    expect(runtimeModeOptions({ runtimeModes: ["full-access", "approval-required"] })).toEqual([
      "approval-required",
      "full-access",
    ]);
  });

  it("treats an empty declaration as unstated rather than offering nothing", () => {
    expect(runtimeModeOptions({ runtimeModes: [] })).toEqual(RuntimeMode.literals);
  });
});

describe("RUNTIME_MODE_LABELS", () => {
  it("names every mode", () => {
    for (const mode of RuntimeMode.literals) {
      expect(RUNTIME_MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
  });
});
