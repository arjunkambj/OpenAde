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

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { Close, File as FileIcon } from "@honeyicons/react";

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
    <span className="group relative inline-flex size-14 overflow-hidden rounded-md bg-muted">
      {url === "" ? null : (
        <img src={url} alt={file.name} title={file.name} className="size-full object-cover" />
      )}
      <span className="absolute top-0.5 right-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                shape="pill"
                aria-label={`Remove attachment ${file.name}`}
                onClick={onRemove}
              />
            }
          >
            <Close />
          </TooltipTrigger>
          <TooltipContent>Remove attachment</TooltipContent>
        </Tooltip>
      </span>
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
          className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md bg-muted pl-1.5 font-mono text-xs"
        >
          <FileIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{path}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  tone="muted"
                  size="icon-xs"
                  aria-label={`Remove mention ${path}`}
                  onClick={() => onRemoveMention(path)}
                />
              }
            >
              <Close />
            </TooltipTrigger>
            <TooltipContent>Remove mention</TooltipContent>
          </Tooltip>
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
