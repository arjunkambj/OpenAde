/**
 * What the composer takes and what it explains away. `readAsBase64` is not
 * covered here: it is a `FileReader` call, which only exists in a browser.
 */

import { MAX_ATTACHMENT_BYTES } from "@OpenAde/shared/imageBytes";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_ACCEPT,
  likelyMediaType,
  rejectionMessage,
  triageAttachments,
} from "./attachment-rules";

const file = (name: string, type: string, size = 16): File =>
  new File([new Uint8Array(size)], name, { type });

describe("likelyMediaType", () => {
  it("believes a declared image type", () => {
    expect(likelyMediaType(file("a.png", "image/png"))).toBe("image/png");
    expect(likelyMediaType(file("a.webp", "image/webp"))).toBe("image/webp");
  });

  it("falls back to the extension, because a drop often declares nothing", () => {
    expect(likelyMediaType(file("holiday.JPG", ""))).toBe("image/jpeg");
    expect(likelyMediaType(file("loop.gif", ""))).toBe("image/gif");
  });

  it("does not take a type the composer cannot send", () => {
    expect(likelyMediaType(file("notes.pdf", "application/pdf"))).toBeNull();
    expect(likelyMediaType(file("logo.svg", "image/svg+xml"))).toBeNull();
    expect(likelyMediaType(file("archive", ""))).toBeNull();
  });
});

describe("triageAttachments", () => {
  it("keeps the images and names what it refused", () => {
    const triage = triageAttachments([
      file("shot.png", "image/png"),
      file("notes.pdf", "application/pdf"),
    ]);
    expect(triage.accepted.map((entry) => entry.name)).toEqual(["shot.png"]);
    expect(triage.rejected).toHaveLength(1);
    expect(triage.rejected[0]?.name).toBe("notes.pdf");
  });

  it("refuses a file over the cap and an empty one", () => {
    const triage = triageAttachments([
      file("huge.png", "image/png", MAX_ATTACHMENT_BYTES + 1),
      file("nothing.png", "image/png", 0),
    ]);
    expect(triage.accepted).toEqual([]);
    expect(triage.rejected.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("the limit is"),
      "it is empty",
    ]);
  });

  it("takes exactly the cap", () => {
    const triage = triageAttachments([file("edge.png", "image/png", MAX_ATTACHMENT_BYTES)]);
    expect(triage.accepted).toHaveLength(1);
  });
});

describe("rejectionMessage", () => {
  it("says nothing when nothing was refused", () => {
    expect(rejectionMessage([])).toBeNull();
  });

  it("names the one file, or counts the several", () => {
    expect(rejectionMessage([{ name: "a.pdf", reason: "it is a pdf" }])).toBe(
      "a.pdf was not attached: it is a pdf",
    );
    const many = rejectionMessage([
      { name: "a.pdf", reason: "one" },
      { name: "b.zip", reason: "two" },
    ]);
    expect(many).toBe("2 files were not attached: a.pdf (one); b.zip (two)");
  });
});

describe("ATTACHMENT_ACCEPT", () => {
  it("offers the picker the same four types the rules allow", () => {
    expect(ATTACHMENT_ACCEPT.split(",")).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
  });
});
