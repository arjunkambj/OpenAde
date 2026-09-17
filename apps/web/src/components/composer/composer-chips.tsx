/**
 * The removable reference row above the textarea: one chip per picked `@`
 * mention and per attached file. Removing a mention chip deletes the token
 * from the draft too, so the submitted `mentions` list and the text can't
 * disagree.
 */

import { Icon } from "@/lib/icon";

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
        <span
          key={`${file.name}-${index}`}
          className="inline-flex max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs"
        >
          <Icon icon="hugeicons:attachment-01" className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{file.name}</span>
          <button
            type="button"
            aria-label={`Remove attachment ${file.name}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onRemoveFile(index)}
          >
            <Icon icon="hugeicons:cancel-01" className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
