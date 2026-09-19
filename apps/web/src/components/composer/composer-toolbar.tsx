/**
 * The composer's bottom row: attach button, live status (running notice,
 * context usage), Stop, and the send/queue button — the queue glyph while a
 * turn runs, matching what Enter would do.
 *
 * Stop only exists while a turn is running and is the visible half of the
 * `thread.interrupt` binding: a user who never learns the chord still has a
 * way to end a turn that is going wrong.
 */

import { Button } from "@OpenAde/ui/components/button";
import * as React from "react";

import { ATTACHMENT_ACCEPT } from "@/components/composer/attachment-rules";

import { Add, ArrowUp, Close, Spinner, Stop as StopIcon } from "@honeyicons/react";

export function ComposerToolbar({
  running,
  canSend,
  contextUsed,
  contextLimit,
  interrupting,
  sending,
  filesKey,
  onFilesPicked,
  onSend,
  onInterrupt,
}: {
  readonly running: boolean;
  readonly canSend: boolean;
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  /** An interrupt is in flight — the turn has not settled yet. */
  readonly interrupting: boolean;
  /** A message is on its way out — the button stays down until it lands. */
  readonly sending: boolean;
  /** Remounts the file input when the attachment list resets, clearing it. */
  readonly filesKey: number;
  readonly onFilesPicked: (files: ReadonlyArray<File>) => void;
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
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
        accept={ATTACHMENT_ACCEPT}
        onChange={(event) => {
          onFilesPicked([...(event.target.files ?? [])]);
          // Emptied on the way out, not only when the list resets: a file the
          // rules refused leaves the list unchanged, so without this the same
          // file picked twice fires no `change` the second time and the user
          // gets no answer at all.
          event.target.value = "";
        }}
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
        <Add />
      </Button>
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {running ? "Turn running — messages queue" : null}
        {contextUsed !== undefined && contextLimit !== undefined ? (
          <span className="tabular-nums" title="Context window used">
            {Math.round((contextUsed / Math.max(1, contextLimit)) * 100)}%
          </span>
        ) : null}
      </span>
      {running ? (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          shape="pill"
          className="shrink-0"
          aria-label="Stop turn"
          title="Stop the running turn (Esc)"
          disabled={interrupting}
          onClick={onInterrupt}
        >
          {interrupting ? <Spinner /> : <StopIcon />}
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        shape="pill"
        className="shrink-0"
        aria-label={running ? "Queue message" : "Send message"}
        title={running ? "Queue message (⌘↵)" : "Send (⏎) · queue (⌘↵)"}
        disabled={!canSend || sending}
        onClick={onSend}
      >
        {sending ? <Spinner /> : running ? <Close /> : <ArrowUp />}
      </Button>
    </div>
  );
}
