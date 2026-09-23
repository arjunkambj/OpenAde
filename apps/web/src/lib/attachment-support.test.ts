import { describe, expect, it } from "vitest";

import { IMAGES_UNSUPPORTED, attachmentRefusal } from "./attachment-support";

describe("attachmentRefusal", () => {
  it("refuses when the harness cannot read images", () => {
    expect(attachmentRefusal({ images: false })).toBe(IMAGES_UNSUPPORTED);
  });

  it("allows attachments when the harness reads images", () => {
    expect(attachmentRefusal({ images: true })).toBeNull();
  });

  it("allows them while the capabilities are still unknown", () => {
    expect(attachmentRefusal(null)).toBeNull();
    expect(attachmentRefusal(undefined)).toBeNull();
  });
});
