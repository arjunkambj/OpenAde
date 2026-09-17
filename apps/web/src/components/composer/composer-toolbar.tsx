/**
 * The composer's bottom row: attach button, live status (running notice,
 * context usage), and the send/queue button — the queue glyph while a turn
 * runs, matching what Enter would do.
 */

import { Button } from "@OpenAde/ui/components/button";
import * as React from "react";

import { Icon } from "@/lib/icon";

export function ComposerToolbar({
  running,
  canSend,
  contextUsed,
  contextLimit,
  filesKey,
  onFilesPicked,
  onSend,
}: {
  readonly running: boolean;
  readonly canSend: boolean;
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  /** Remounts the file input when the attachment list resets, clearing it. */
  readonly filesKey: number;
  readonly onFilesPicked: (files: ReadonlyArray<File>) => void;
  readonly onSend: () => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        key={filesKey}
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        onChange={(event) => onFilesPicked([...(event.target.files ?? [])])}
      />
      <Button
        type="button"
        variant="ghost"
        tone="muted"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach files"
        onClick={() => fileInputRef.current?.click()}
      >
        <Icon icon="hugeicons:add-01" />
      </Button>
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {running ? "Turn running — messages queue" : null}
        {contextUsed !== undefined && contextLimit !== undefined ? (
          <span className="tabular-nums" title="Context window used">
            {Math.round((contextUsed / Math.max(1, contextLimit)) * 100)}%
          </span>
        ) : null}
      </span>
      <Button
        type="button"
        size="icon-sm"
        shape="pill"
        className="shrink-0"
        aria-label={running ? "Queue message" : "Send message"}
        title={running ? "Queue message (⌘↵)" : "Send (⏎) · queue (⌘↵)"}
        disabled={!canSend}
        onClick={onSend}
      >
        <Icon icon={running ? "hugeicons:queue-02" : "hugeicons:arrow-up-02"} />
      </Button>
    </div>
  );
}
