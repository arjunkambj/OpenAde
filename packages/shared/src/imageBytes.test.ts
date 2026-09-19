import { describe, expect, it } from "vitest";

import {
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  safeAttachmentName,
  sniffImageMediaType,
} from "./imageBytes";

const bytes = (...values: ReadonlyArray<number>): Uint8Array => Uint8Array.from(values);

const ascii = (text: string, ...tail: ReadonlyArray<number>): Uint8Array =>
  Uint8Array.from([...[...text].map((character) => character.charCodeAt(0)), ...tail]);

/** A RIFF container of `form`: the magic, a size field, then the form name. */
const riff = (form: string): Uint8Array =>
  Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii(form)]);

describe("sniffImageMediaType", () => {
  it("recognises each accepted format by its signature", () => {
    expect(sniffImageMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(
      "image/png",
    );
    expect(sniffImageMediaType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toBe("image/jpeg");
    expect(sniffImageMediaType(ascii("GIF87a", 0x01))).toBe("image/gif");
    expect(sniffImageMediaType(ascii("GIF89a", 0x01))).toBe("image/gif");
    expect(sniffImageMediaType(riff("WEBPVP8 "))).toBe("image/webp");
  });

  it("names a media type for every accepted format and an extension for each", () => {
    for (const mediaType of IMAGE_MEDIA_TYPES) {
      expect(IMAGE_EXTENSIONS[mediaType]).toMatch(/^[a-z]+$/u);
    }
  });

  it("refuses bytes that only claim to be an image", () => {
    // A shell script named screenshot.png — the case the sniff exists for.
    expect(sniffImageMediaType(ascii("#!/bin/sh\nrm -rf /\n"))).toBeNull();
    // An SVG is an image to a browser and a script host to an attacker.
    expect(sniffImageMediaType(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    // A RIFF container that is a WAV, not a WEBP.
    expect(sniffImageMediaType(riff("WAVEfmt "))).toBeNull();
    expect(sniffImageMediaType(new Uint8Array())).toBeNull();
  });

  it("never reads past the end of a truncated header", () => {
    expect(sniffImageMediaType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffImageMediaType(ascii("RIFF"))).toBeNull();
  });
});

describe("safeAttachmentName", () => {
  it("keeps only the basename, so a traversal cannot survive it", () => {
    expect(safeAttachmentName("../../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("..\\..\\windows\\system32\\config")).toBe("config");
    expect(safeAttachmentName("..")).toBe("image");
  });

  it("folds everything a shell or a path would read specially", () => {
    expect(safeAttachmentName("my shot; rm -rf $HOME.png")).toBe("my-shot--rm--rf--HOME.png");
    expect(safeAttachmentName(".hidden.png")).toBe("hidden.png");
  });

  it("caps the length and always returns something", () => {
    expect(safeAttachmentName(`${"a".repeat(200)}.png`)).toHaveLength(60);
    expect(safeAttachmentName("")).toBe("image");
    expect(safeAttachmentName("🙂")).toBe("image");
  });
});
