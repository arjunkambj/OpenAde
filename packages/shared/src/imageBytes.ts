/**
 * What counts as an attachable image, decided by the bytes.
 *
 * The one place in the app that answers "is this an image, and which kind?".
 * A file name lies, and so does a browser's `File.type` — both are attacker
 * controlled the moment a file arrives from outside. Every producer and every
 * consumer of an attachment sniffs here instead: the server before it writes a
 * staged file, the server again before it serves one back, the composer before
 * it bothers uploading.
 *
 * Signatures are the documented ones and no more: PNG's eight-byte header,
 * JPEG's `FF D8 FF` SOI, the two GIF versions, and RIFF/WEBP's split container
 * magic. Anything else is not an image as far as Poseidon is concerned.
 */

/** The media types the composer accepts, in the order the file picker lists. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * The per-file ceiling, enforced on the base64 text, on the decoded bytes and
 * again on the way back out. Large enough for a retina screenshot, small enough
 * that a stray drop of a video cannot wedge a WebSocket frame.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The extension a staged file is stored under, chosen by the sniff. */
export const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>): boolean => {
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
};

/** ASCII bytes of `text`, compared at `offset`. */
const hasAscii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** SOI plus the first marker byte; the fourth byte varies by encoder. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/**
 * The media type `bytes` really are, or `null` when they are not one of the
 * four. Never throws and never reads past the header, so it is safe to call on
 * a truncated read.
 */
export const sniffImageMediaType = (bytes: Uint8Array): ImageMediaType | null => {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  if (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  // RIFF containers name their form at byte 8; only the WEBP form is an image.
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
};

/**
 * A file name safe to put on disk and in a prompt line: the basename only,
 * every character outside `[A-Za-z0-9._-]` folded to `-`, leading dots dropped
 * so nothing becomes hidden, and capped. `..` cannot survive it, which is half
 * of why a staged path stays inside its thread's directory.
 */
export const safeAttachmentName = (name: string): string => {
  const base = name.split(/[/\\]/u).pop() ?? "";
  const folded = base.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[.-]+/u, "");
  const trimmed = folded.slice(0, 60);
  return trimmed === "" ? "image" : trimmed;
};
