/**
 * A turn's attachments, as the CLI takes them.
 *
 * The SDK's user message carries image content blocks, so an image goes to
 * the model as itself: the file's bytes, base64, with the media type its own
 * magic bytes say (`@poseidon/shared/imageBytes`) — never the name or the type
 * the reference claims. The model sees the picture without a tool call.
 *
 * Any other file is named by path, the way Command Code's are: it is put under
 * `<attachmentsDir>/<threadId>/`, which the session adds to the CLI's readable
 * directories (`queryOptions.ts`), and the prompt gets a line naming its
 * absolute path and media type, so the model reads it with its own tools.
 * Most files are already there — the server stages a composer upload straight
 * into that directory — and one that is not is copied in. An image that cannot
 * be read, or is larger than `MAX_ATTACHMENT_BYTES`, is named by path the same
 * way.
 *
 * Nothing here fails the turn. A copy or a read that fails leaves the original
 * path in the prompt and a warning the session passes on, because a turn the
 * user asked for is better than no turn.
 */

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { ThreadId } from "@poseidon/contracts/ids";
import {
  MAX_ATTACHMENT_BYTES,
  safeAttachmentName,
  sniffImageMediaType,
  type ImageMediaType,
} from "@poseidon/shared/imageBytes";

type Attachment = TurnInput["attachments"][number];

/** One image, as the SDK's base64 image content block wants it. */
export interface ImageBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: ImageMediaType;
    readonly data: string;
  };
}

export interface StagedAttachments {
  /** The images, in the order they were attached. */
  readonly images: ReadonlyArray<ImageBlock>;
  /** One line per file named by path, appended to the prompt. */
  readonly promptLines: ReadonlyArray<string>;
  /** What could not be done; the session says each as a `session.warning`. */
  readonly warnings: ReadonlyArray<string>;
}

const NOTHING: StagedAttachments = { images: [], promptLines: [], warnings: [] };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const nameOf = (attachment: Attachment): string =>
  attachment.name ?? NodePath.basename(attachment.path);

/** `child` is inside `parent`, compared on resolved paths. */
const isInside = (parent: string, child: string): boolean =>
  NodePath.resolve(child).startsWith(NodePath.resolve(parent) + NodePath.sep);

/**
 * A name for a copy that cannot collide with another attachment's and cannot
 * escape the directory: the content hash when the reference carries one, the
 * attachment's place otherwise.
 */
const copyNameFor = (attachment: Attachment, index: number): string => {
  const prefix = attachment.sha256 === undefined ? `${index}` : attachment.sha256.slice(0, 12);
  return `${prefix}-${safeAttachmentName(nameOf(attachment))}`;
};

/**
 * What the model reads. The media type is stated because a path alone does
 * not say what the file is, and the model has to choose to open it.
 */
const attachmentLine = (path: string, mime: string | undefined): string =>
  mime === undefined ? `Attachment: ${path}` : `Attachment (${mime}): ${path}`;

/** The file's bytes when it is an image the model can be shown, else null. */
const imageOf = async (path: string): Promise<ImageBlock | null> => {
  const size = (await stat(path)).size;
  if (size > MAX_ATTACHMENT_BYTES) return null;
  const bytes = await readFile(path);
  const mediaType = sniffImageMediaType(bytes);
  return mediaType === null
    ? null
    : {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
      };
};

/** Every attachment of a turn, as image blocks and prompt lines. */
export const stageAttachments = async (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<Attachment>;
}): Promise<StagedAttachments> => {
  if (input.attachments.length === 0) return NOTHING;
  const directory = NodePath.join(NodePath.resolve(input.attachmentsDir), input.threadId);
  const images: Array<ImageBlock> = [];
  const promptLines: Array<string> = [];
  const warnings: Array<string> = [];

  for (const [index, attachment] of input.attachments.entries()) {
    const absolute = NodePath.resolve(attachment.path);
    try {
      const image = await imageOf(absolute);
      if (image !== null) {
        images.push(image);
        continue;
      }
    } catch (cause) {
      warnings.push(`could not read the attachment ${nameOf(attachment)}: ${messageOf(cause)}`);
      promptLines.push(attachmentLine(absolute, attachment.mime));
      continue;
    }
    if (isInside(directory, absolute)) {
      // The server already staged it; copying again would only duplicate it.
      promptLines.push(attachmentLine(absolute, attachment.mime));
      continue;
    }
    const target = NodePath.join(directory, copyNameFor(attachment, index));
    try {
      await mkdir(directory, { recursive: true });
      await copyFile(absolute, target);
      promptLines.push(attachmentLine(target, attachment.mime));
    } catch (cause) {
      warnings.push(`could not copy the attachment ${nameOf(attachment)}: ${messageOf(cause)}`);
      promptLines.push(attachmentLine(absolute, attachment.mime));
    }
  }

  return { images, promptLines, warnings };
};
