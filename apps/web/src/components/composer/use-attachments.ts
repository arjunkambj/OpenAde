/**
 * The composer's attachment list: the three ways a file gets into it (paste,
 * drop, picker), what it refuses, and how the ones it keeps become references
 * the turn can carry.
 *
 * Drop needs `dragover` cancelled — Chromium delivers `drop` only when the
 * preceding `dragover` was cancelled, so a bare `onDrop` never fires. Drops
 * that land anywhere else are swallowed by `DropNavigationGuard` in
 * `routes/__root.tsx`, which is mounted on every route — this hook is not, and
 * a page with no composer must not be navigable away by a stray drop either.
 *
 * `stage` is the step that used to be missing: a browser `File` has no
 * filesystem path, so sending `file.name` sent a name that resolved to nothing
 * and the bytes were dropped on the floor. The bytes go up once, the server
 * writes them under the thread's attachments directory, and only the reference
 * it answers with rides the command.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { Attachment } from "@OpenAde/contracts/orchestration";
import * as React from "react";

import {
  readAsBase64,
  rejectionMessage,
  triageAttachments,
} from "@/components/composer/attachment-rules";
import { useClientRuntime } from "@/lib/client-runtime";

/**
 * One upload round. `files` is the list `stage` actually read, so a file that
 * arrived while the bytes were going up is not in it and survives the clear.
 */
export interface StagedAttachments {
  readonly files: ReadonlyArray<File>;
  readonly references: ReadonlyArray<Attachment>;
}

export interface Attachments {
  readonly files: ReadonlyArray<File>;
  readonly dragging: boolean;
  /** The last batch's refusals, as one sentence, or `null`. */
  readonly rejected: string | null;
  readonly add: (files: ReadonlyArray<File>) => void;
  readonly removeAt: (index: number) => void;
  readonly clear: () => void;
  /**
   * When attaching is refused, says so in `rejected` and answers true — for an
   * attach that does not go through `add`, such as the attach key.
   */
  readonly refuse: () => boolean;
  /** Forgets exactly the files `stage` uploaded, by identity. */
  readonly clearStaged: (uploaded: ReadonlyArray<File>) => void;
  /** Uploads every kept file and resolves with what went up and what came back. */
  readonly stage: () => Promise<StagedAttachments>;
  readonly onPaste: (event: React.ClipboardEvent) => void;
  readonly dropHandlers: {
    readonly onDragEnter: (event: React.DragEvent) => void;
    readonly onDragOver: (event: React.DragEvent) => void;
    readonly onDragLeave: (event: React.DragEvent) => void;
    readonly onDrop: (event: React.DragEvent) => void;
  };
}

/**
 * `files` and `setFiles` are the caller's, not this hook's: staged files are
 * part of the per-thread draft (`@/state/ui`), so that a thread switch — which
 * unmounts the composer — does not throw a pasted screenshot away. Everything
 * about *this* round of picking, dropping and refusing stays local.
 *
 * `refusal` is set when the thread's connector cannot take attachments at all
 * (`@/lib/attachment-support`): the picker is disabled by the toolbar, and a
 * paste or a drop is refused here with the same reason.
 */
export function useAttachments(
  threadId: ThreadId,
  files: ReadonlyArray<File>,
  setFiles: React.Dispatch<React.SetStateAction<ReadonlyArray<File>>>,
  refusal: string | null = null,
): Attachments {
  const { stageAttachmentAtom } = useClientRuntime();
  const stageOne = useAtomSet(stageAttachmentAtom, { mode: "promise" });
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const add = React.useCallback(
    (added: ReadonlyArray<File>) => {
      if (refusal !== null) {
        setRejected(refusal);
        return;
      }
      const triage = triageAttachments(added);
      setRejected(rejectionMessage(triage.rejected));
      if (triage.accepted.length > 0) {
        setFiles((current) => [...current, ...triage.accepted]);
      }
    },
    [setFiles, refusal],
  );

  const stage = React.useCallback(async (): Promise<StagedAttachments> => {
    const uploading = files;
    const references: Array<Attachment> = [];
    for (const file of uploading) {
      const base64 = await readAsBase64(file);
      const reference = await stageOne({ threadId, name: file.name, base64 });
      references.push({
        path: reference.path,
        mime: reference.mime,
        name: reference.name,
        size: reference.size,
        sha256: reference.sha256,
      });
    }
    return { files: uploading, references };
  }, [files, stageOne, threadId]);

  return {
    files,
    dragging,
    rejected,
    add,
    stage,
    removeAt: React.useCallback(
      (index: number) => setFiles((current) => current.filter((_, i) => i !== index)),
      [setFiles],
    ),
    clear: React.useCallback(() => {
      setFiles([]);
      setRejected(null);
    }, [setFiles]),
    refuse: React.useCallback(() => {
      if (refusal === null) {
        return false;
      }
      setRejected(refusal);
      return true;
    }, [refusal]),
    clearStaged: React.useCallback(
      (uploaded: ReadonlyArray<File>) => {
        setFiles((current) => current.filter((file) => !uploaded.includes(file)));
        setRejected(null);
      },
      [setFiles],
    ),
    onPaste: React.useCallback(
      (event: React.ClipboardEvent) => {
        const pasted = [...event.clipboardData.files];
        if (pasted.length > 0) {
          event.preventDefault();
          add(pasted);
        }
      },
      [add],
    ),
    dropHandlers: {
      onDragEnter: (event) => {
        event.preventDefault();
        setDragging(true);
      },
      onDragOver: (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      },
      onDrop: (event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length > 0) {
          add([...event.dataTransfer.files]);
        }
      },
    },
  };
}
