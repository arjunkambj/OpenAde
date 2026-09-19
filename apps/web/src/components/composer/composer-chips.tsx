/**
 * The removable reference row above the textarea: one chip per picked `@`
 * mention and one thumbnail per attached image. Removing a mention chip
 * deletes the token from the draft too, so the submitted `mentions` list and
 * the text can't disagree.
 *
 * An attached image shows itself rather than its name: the point of pasting a
 * screenshot is to check you pasted the right one. The preview is a local
 * object URL — the file has not been uploaded yet at this stage — and it is
 * revoked when the chip goes away, so a long editing session does not pile up
 * blobs.
 */

import * as React from "react";

import { Icon } from "@/lib/icon";

/** A blob URL for `file` that is revoked when the component unmounts. */
function useObjectUrl(file: File): string {
  const [url, setUrl] = React.useState("");
  React.useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function AttachmentChip({
  file,
  onRemove,
}: {
  readonly file: File;
  readonly onRemove: () => void;
}) {
  const url = useObjectUrl(file);
  return (
    <span className="group relative inline-flex size-14 overflow-hidden rounded-md border border-border bg-muted">
      {url === "" ? null : (
        <img src={url} alt={file.name} title={file.name} className="size-full object-cover" />
      )}
      <button
        type="button"
        aria-label={`Remove attachment ${file.name}`}
        className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        onClick={onRemove}
      >
        <Icon icon="hugeicons:cancel-01" className="size-3" />
      </button>
    </span>
  );
}

export function ComposerChips({
  mentions,
  files,
  onRemoveMention,
  onRemoveFile,
}: {
  readonly mentions: ReadonlyArray<string>;
  readonly files: ReadonlyArray<File>;
  readonly onRemoveMention: (path: string) => void;
  readonly onRemoveFile: (index: number) => void;
}) {
  if (mentions.length === 0 && files.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {mentions.map((path) => (
        <span
          key={path}
          className="inline-flex max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs"
        >
          <Icon icon="hugeicons:file-02" className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{path}</span>
          <button
            type="button"
            aria-label={`Remove mention ${path}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onRemoveMention(path)}
          >
            <Icon icon="hugeicons:cancel-01" className="size-3" />
          </button>
        </span>
      ))}
      {files.map((file, index) => (
        <AttachmentChip
          key={`${file.name}-${file.lastModified}-${index}`}
          file={file}
          onRemove={() => onRemoveFile(index)}
        />
      ))}
    </div>
  );
}
