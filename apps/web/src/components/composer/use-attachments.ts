/**
 * The composer's attachment list and the two ways files get into it: paste
 * and drop.
 *
 * Drop needs `dragover` cancelled — Chromium delivers `drop` only when the
 * preceding `dragover` was cancelled, so a bare `onDrop` never fires. The
 * window-level guard covers everywhere else: an uncancelled drop is a
 * navigation, which in the desktop shell replaces the app with the file.
 * Anything with its own drop target cancels the event first, so the guard
 * only eats what nothing wanted.
 */

import * as React from "react";

export interface Attachments {
  readonly files: ReadonlyArray<File>;
  readonly dragging: boolean;
  readonly add: (files: ReadonlyArray<File>) => void;
  readonly removeAt: (index: number) => void;
  readonly clear: () => void;
  readonly onPaste: (event: React.ClipboardEvent) => void;
  readonly dropHandlers: {
    readonly onDragEnter: (event: React.DragEvent) => void;
    readonly onDragOver: (event: React.DragEvent) => void;
    readonly onDragLeave: (event: React.DragEvent) => void;
    readonly onDrop: (event: React.DragEvent) => void;
  };
}

export function useAttachments(): Attachments {
  const [files, setFiles] = React.useState<ReadonlyArray<File>>([]);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (!event.defaultPrevented) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const add = React.useCallback(
    (added: ReadonlyArray<File>) => setFiles((current) => [...current, ...added]),
    [],
  );

  return {
    files,
    dragging,
    add,
    removeAt: React.useCallback(
      (index: number) => setFiles((current) => current.filter((_, i) => i !== index)),
      [],
    ),
    clear: React.useCallback(() => setFiles([]), []),
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
