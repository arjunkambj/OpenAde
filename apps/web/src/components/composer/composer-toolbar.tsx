/**
 * The composer's bottom row: attach button, live status (the steering notice,
 * context usage), Stop, and the send button — which, like Enter, steers the
 * running turn when the harness can take a message mid-turn and shows the
 * queue glyph while a turn runs otherwise. The queue chord still queues.
 *
 * Stop only exists while a turn is running and is the visible half of the
 * `thread.interrupt` binding: a user who never learns the chord still has a
 * way to end a turn that is going wrong.
 *
 * Attach is disabled, with the reason as its tooltip, when the thread's
 * connector cannot take attachments (`@/lib/attachment-support`). The file
 * input's ref is the caller's, so the `composer.attach` key can open the same
 * chooser (`./use-composer-commands`).
 */

import { Button } from "@OpenAde/ui/components/button";
import { Kbd } from "@OpenAde/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type * as React from "react";

import { ATTACHMENT_ACCEPT } from "@/components/composer/attachment-rules";
import { CommandKbd } from "@/lib/shortcuts";

import { Add, ArrowUp, ListOrdered, Send, Spinner, Stop as StopIcon } from "@honeyicons/react";

export function ComposerToolbar({
  settings,
  running,
  steerable,
  canSend,
  contextUsed,
  contextLimit,
  interrupting,
  sending,
  filesKey,
  fileInputRef,
  onFilesPicked,
  onSend,
  onInterrupt,
  attachDisabledReason,
}: {
  readonly settings?: React.ReactNode;
  readonly running: boolean;
  /** A turn runs and its harness takes messages into it: sending steers. */
  readonly steerable: boolean;
  readonly canSend: boolean;
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  /** An interrupt is in flight — the turn has not settled yet. */
  readonly interrupting: boolean;
  /** A message is on its way out — the button stays down until it lands. */
  readonly sending: boolean;
  /** Remounts the file input when the attachment list resets, clearing it. */
  readonly filesKey: number;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onFilesPicked: (files: ReadonlyArray<File>) => void;
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
  /** Why attaching is refused; the button is disabled when it is set. */
  readonly attachDisabledReason?: string;
}) {
  const attachDisabled = attachDisabledReason !== undefined;
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
      {/* The trigger wraps the button rather than being it: a disabled button
          takes no pointer events, and the tooltip is where a refused attach
          says why. */}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            tone="muted"
            size="icon"
            aria-label="Attach files"
            disabled={attachDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Add variant="bold" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {attachDisabledReason ?? (
            <>
              Attach files
              <CommandKbd command="composer.attach" />
            </>
          )}
        </TooltipContent>
      </Tooltip>
      {settings}
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {steerable ? <span>Steering the running turn</span> : null}
        {contextUsed !== undefined && contextLimit !== undefined ? (
          <span className="tabular-nums" title="Context window used">
            {Math.round((contextUsed / Math.max(1, contextLimit)) * 100)}%
          </span>
        ) : null}
      </span>
      {running ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon"
                shape="pill"
                className="shrink-0"
                aria-label="Stop turn"
                disabled={interrupting}
                onClick={onInterrupt}
              />
            }
          >
            {interrupting ? <Spinner variant="bold" /> : <StopIcon variant="bold" />}
          </TooltipTrigger>
          <TooltipContent>
            Stop turn
            <CommandKbd command="thread.interrupt" />
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon"
              shape="pill"
              className="shrink-0"
              aria-label={steerable ? "Steer turn" : running ? "Queue message" : "Send message"}
              disabled={!canSend || sending}
              onClick={onSend}
            />
          }
        >
          {sending ? (
            <Spinner variant="bold" />
          ) : steerable ? (
            <Send variant="bold" />
          ) : running ? (
            <ListOrdered variant="bold" />
          ) : (
            <ArrowUp variant="bold" />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {steerable ? (
            <span className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5">
                Send to the running turn<Kbd>↵</Kbd>
              </span>
              <span className="flex items-center gap-1.5">
                Queue instead
                <CommandKbd command="composer.queue" />
              </span>
            </span>
          ) : running ? (
            <>
              Queue message
              <CommandKbd command="composer.queue" />
            </>
          ) : (
            <>
              Send<Kbd>↵</Kbd>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
