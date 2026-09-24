import { RuntimeMode } from "@poseidon/contracts/enums";
import { describe, expect, it } from "vitest";

import { nextRuntimeMode, RUNTIME_MODE_LABELS, runtimeModeOptions } from "./runtime-modes";

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

describe("nextRuntimeMode", () => {
  it("steps through every mode in contract order and wraps", () => {
    expect(nextRuntimeMode("approval-required", RuntimeMode.literals)).toBe("auto-accept-edits");
    expect(nextRuntimeMode("auto-accept-edits", RuntimeMode.literals)).toBe("full-access");
    expect(nextRuntimeMode("full-access", RuntimeMode.literals)).toBe("approval-required");
  });

  it("skips a mode the connector does not offer, whatever order it listed them in", () => {
    const offered = ["full-access", "approval-required"] as const;
    expect(nextRuntimeMode("approval-required", offered)).toBe("full-access");
    expect(nextRuntimeMode("full-access", offered)).toBe("approval-required");
  });

  it("moves an unsupported current mode on to the next offered one", () => {
    expect(nextRuntimeMode("auto-accept-edits", ["approval-required", "full-access"])).toBe(
      "full-access",
    );
    expect(nextRuntimeMode("full-access", ["auto-accept-edits"])).toBe("auto-accept-edits");
  });

  it("stays put when only the current mode is on offer, or nothing is", () => {
    expect(nextRuntimeMode("full-access", ["full-access"])).toBe("full-access");
    expect(nextRuntimeMode("full-access", [])).toBe("full-access");
  });
});
