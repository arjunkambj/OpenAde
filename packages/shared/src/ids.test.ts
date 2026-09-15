import { describe, expect, it } from "vitest";

import { isUuidV7, uuidV7, uuidV7Millis } from "./ids";

describe("uuidV7", () => {
  it("produces a well-formed v7 identifier", () => {
    const id = uuidV7();
    expect(isUuidV7(id)).toBe(true);
    expect(id).toHaveLength(36);
    // Version nibble is 7 and the variant nibble is one of 8, 9, a, b.
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("carries the current time in its leading 48 bits", () => {
    const before = Date.now();
    const millis = uuidV7Millis(uuidV7());
    const after = Date.now();
    expect(millis).toBeDefined();
    expect(millis as number).toBeGreaterThanOrEqual(before);
    expect(millis as number).toBeLessThanOrEqual(after + 1);
  });

  it("is strictly increasing and unique across a burst", () => {
    const ids = Array.from({ length: 10_000 }, () => uuidV7());
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < ids.length; index += 1) {
      expect((ids[index] as string) > (ids[index - 1] as string)).toBe(true);
    }
  });

  it("sorts lexicographically in generation order", () => {
    const ids = Array.from({ length: 256 }, () => uuidV7());
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("isUuidV7", () => {
  it("rejects other uuid versions and malformed input", () => {
    expect(isUuidV7("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isUuidV7("00000000-0000-7000-0000-000000000000")).toBe(false);
    expect(isUuidV7("not-a-uuid")).toBe(false);
    expect(isUuidV7(uuidV7().toUpperCase())).toBe(false);
  });
});

describe("uuidV7Millis", () => {
  it("returns undefined for anything that is not a uuid v7", () => {
    expect(uuidV7Millis("nope")).toBeUndefined();
  });
});
