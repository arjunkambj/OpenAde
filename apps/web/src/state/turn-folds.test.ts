import { describe, expect, it } from "vitest";

import { openFoldKey } from "./turn-folds";

describe("openFoldKey", () => {
  it("keeps only the open turn folds, sorted, so equal slices compare equal", () => {
    expect(
      openFoldKey({
        "turn-fold:b": true,
        "work-group:x": true,
        "turn-fold:a": true,
        "turn-fold:c": false,
        "item-1": true,
      }),
    ).toBe("turn-fold:a\nturn-fold:b");
    expect(openFoldKey({ "turn-fold:a": true, "work-group:y": false })).toBe(
      openFoldKey({ "work-group:y": true, "turn-fold:a": true }),
    );
  });

  it("is empty when no fold is open", () => {
    expect(openFoldKey({})).toBe("");
    expect(openFoldKey({ "turn-fold:a": false })).toBe("");
  });
});
