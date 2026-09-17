/**
 * Handing a turn's attachments to the harness.
 *
 * Print mode has no image flag — the probe of `command-code@1.54.0 --help`
 * found none, and the spec records the same gap (§5.7) with the fallback this
 * module implements: put the file under `<attachmentsDir>/<threadId>/`, add
 * that directory to the run's workspace scope, and name the absolute path in
 * the prompt so the model reads it (decision docs/decisions/w10-attachments.md).
 *
 * Most files are already there: the server stages a composer upload straight
 * into that directory. One that is not — a path that came from somewhere else —
 * is copied in, which is what §8 step 1 asks for. A copy that fails is not
 * fatal: the original path is used and the session says so, because a turn the
 * user asked for is better than no turn.
 *
 * Nothing here runs a shell. The paths end up as one argv element each and as
 * text inside the prompt, so a file name is never interpreted.
 */

import { copyFile, mkdir } from "node:fs/promises";
import * as NodePath from "node:path";
import type { Attachment } from "@OpenAde/contracts/orchestration";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { safeAttachmentName } from "@OpenAde/shared/imageBytes";

export interface StagedTurnAttachments {
  /** One line per attachment, appended to the prompt. */
  readonly promptLines: ReadonlyArray<string>;
  /** Directories to pass as `--add-dir`, so the harness may read the files. */
  readonly addDirs: ReadonlyArray<string>;
  /** Copies that failed; the caller turns each into a `session.warning`. */
  readonly warnings: ReadonlyArray<string>;
}

const EMPTY: StagedTurnAttachments = { promptLines: [], addDirs: [], warnings: [] };

/** `child` is inside `parent`, compared on resolved paths. */
const isInside = (parent: string, child: string): boolean => {
  const root = NodePath.resolve(parent);
  const resolved = NodePath.resolve(child);
  return resolved.startsWith(root + NodePath.sep);
};

/**
 * A name for a copy that cannot collide with another attachment's and cannot
 * escape the directory: the content hash when the reference carries one, the
 * index otherwise.
 */
const copyNameFor = (attachment: Attachment, index: number): string => {
  const base = safeAttachmentName(attachment.name ?? NodePath.basename(attachment.path));
  const prefix = attachment.sha256 === undefined ? `${index}` : attachment.sha256.slice(0, 12);
  return `${prefix}-${base}`;
};

/**
 * Puts every attachment where the harness can read it and describes how to
 * tell it about them. Returns absolute paths only.
 */
export const stageTurnAttachments = async (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<Attachment>;
}): Promise<StagedTurnAttachments> => {
  if (input.attachments.length === 0) {
    return EMPTY;
  }
  const directory = NodePath.join(NodePath.resolve(input.attachmentsDir), input.threadId);
  const promptLines: Array<string> = [];
  const warnings: Array<string> = [];
  let used = false;

  for (const [index, attachment] of input.attachments.entries()) {
    const absolute = NodePath.resolve(attachment.path);
    if (isInside(directory, absolute)) {
      // The server already staged it; copying again would only duplicate it.
      promptLines.push(promptLineFor(attachment, absolute));
      used = true;
      continue;
    }
    const target = NodePath.join(directory, copyNameFor(attachment, index));
    try {
      await mkdir(directory, { recursive: true });
      await copyFile(absolute, target);
      promptLines.push(promptLineFor(attachment, target));
      used = true;
    } catch (cause) {
      warnings.push(
        `could not copy the attachment ${attachment.name ?? NodePath.basename(attachment.path)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      // Best effort: the original path may still be readable from the
      // workspace, and a turn that mentions it beats a turn that drops it.
      promptLines.push(promptLineFor(attachment, absolute));
    }
  }

  return { promptLines, addDirs: used ? [directory] : [], warnings };
};

/**
 * What the model sees. The media type is stated because the path alone does not
 * say "look at this as a picture", and the harness has to choose to read it.
 */
const promptLineFor = (attachment: Attachment, path: string): string =>
  attachment.mime === undefined
    ? `Attachment: ${path}`
    : `Attachment (${attachment.mime}): ${path}`;
