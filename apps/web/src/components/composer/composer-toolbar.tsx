/**
 * The composer's bottom row: attach button, live status (running notice,
 * context usage), Stop, and the send/queue button — the queue glyph while a
 * turn runs, matching what Enter would do.
 *
 * Stop only exists while a turn is running and is the visible half of the
 * `thread.interrupt` binding: a user who never learns the chord still has a
 * way to end a turn that is going wrong.
 *
 * Attach is disabled, with the reason as its tooltip, when the thread's
 * connector cannot take attachments (`@/lib/attachment-support`).
 */

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { ATTACHMENT_ACCEPT } from "@/components/composer/attachment-rules";

import { Add, ArrowUp, Close, Spinner, Stop as StopIcon } from "@honeyicons/react";

export function ComposerToolbar({
  settings,
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
  attachDisabledReason,
}: {
  readonly settings?: React.ReactNode;
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
  /** Why attaching is refused; the button is disabled when it is set. */
  readonly attachDisabledReason?: string;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const attachDisabled = attachDisabledReason !== undefined;
  const attach = (
    <Button
      type="button"
      variant="ghost"
      tone="muted"
      size="icon"
      aria-label="Attach files"
      title={attachDisabled ? undefined : "Attach files"}
      disabled={attachDisabled}
      onClick={() => fileInputRef.current?.click()}
    >
      <Add />
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
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
      {attachDisabled ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{attach}</TooltipTrigger>
          <TooltipContent>{attachDisabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        attach
      )}
      {settings}
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
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
          size="icon"
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
        size="icon"
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
