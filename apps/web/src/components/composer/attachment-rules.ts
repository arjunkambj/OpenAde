/**
 * What the composer will take, and how a picked file becomes bytes.
 *
 * The checks here are a courtesy, not a defence: they let the user hear "that
 * is 40 MB" before the upload rather than after it. The server sniffs the
 * file's own header and refuses anything that is not really an image, so a
 * `File` whose `type` lies gets no further than the staging call.
 *
 * `type` is unreliable in the other direction too — a drag from a file manager
 * often arrives with an empty one — so a missing type falls back to the
 * extension instead of rejecting a picture outright.
 */

import {
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "@poseidon/shared/imageBytes";
import type { ImageMediaType } from "@poseidon/shared/imageBytes";

/** The `accept` attribute of the file picker, from the one list of types. */
export const ATTACHMENT_ACCEPT = IMAGE_MEDIA_TYPES.join(",");

/** A file the composer will not take, and the sentence to show about it. */
export interface RejectedAttachment {
  readonly name: string;
  readonly reason: string;
}

export interface AttachmentTriage {
  readonly accepted: ReadonlyArray<File>;
  readonly rejected: ReadonlyArray<RejectedAttachment>;
}

const EXTENSIONS: ReadonlyArray<readonly [string, ImageMediaType]> = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
];

const isImageMediaType = (value: string): value is ImageMediaType =>
  (IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(value);

/** The type this file probably is, by declaration or by extension. */
export const likelyMediaType = (file: File): ImageMediaType | null => {
  if (isImageMediaType(file.type)) {
    return file.type;
  }
  const lower = file.name.toLowerCase();
  return EXTENSIONS.find(([extension]) => lower.endsWith(extension))?.[1] ?? null;
};

const megabytes = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** Splits a batch into what the composer keeps and what it explains away. */
export const triageAttachments = (files: ReadonlyArray<File>): AttachmentTriage => {
  const accepted: Array<File> = [];
  const rejected: Array<RejectedAttachment> = [];
  for (const file of files) {
    if (likelyMediaType(file) === null) {
      rejected.push({
        name: file.name,
        reason: `only ${Object.values(IMAGE_EXTENSIONS).join(", ")} images can be attached`,
      });
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        name: file.name,
        reason: `it is ${megabytes(file.size)}; the limit is ${megabytes(MAX_ATTACHMENT_BYTES)}`,
      });
    } else if (file.size === 0) {
      rejected.push({ name: file.name, reason: "it is empty" });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
};

/** One sentence for however many files were turned away. */
export const rejectionMessage = (rejected: ReadonlyArray<RejectedAttachment>): string | null =>
  rejected.length === 0
    ? null
    : rejected.length === 1
      ? `${rejected[0]!.name} was not attached: ${rejected[0]!.reason}`
      : `${rejected.length} files were not attached: ${rejected
          .map((entry) => `${entry.name} (${entry.reason})`)
          .join("; ")}`;

/**
 * The file's bytes as base64, without the `data:` prefix `readAsDataURL` adds.
 * `FileReader` rather than `arrayBuffer()` + manual encoding: the browser does
 * the base64 in one step and out of the main thread's way.
 */
export const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma === -1) {
        reject(new Error(`could not read ${file.name}`));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
