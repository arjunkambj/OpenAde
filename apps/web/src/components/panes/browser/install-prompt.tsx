/**
 * What the pane shows when the browser tool is missing, on the stock `Empty`:
 * the commands the mode needs, each copyable, and a retry (a reload gesture —
 * in-app it clears the error for the agent's next call, in owned mode it
 * starts the browser again).
 *
 * This replaces the error string being squeezed into the toolbar chip — the
 * one failure the user can actually fix deserves the whole surface.
 */
import * as React from "react";

import type { BrowserState } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { installCommands } from "./install";
import { Check, Copy as CopyIcon, Globe } from "@honeyicons/react";

function CommandRow({ command, note }: { command: string; note: string }) {
  const [copied, setCopied] = React.useState(false);

  // The "copied" tick resets itself; clearing on unmount keeps the timer from
  // setting state on a pane the user has already closed.
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-hover px-2 py-1.5 font-mono text-xs">
        {command}
      </code>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{note}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={copy}
              aria-label={`Copy ${command}`}
            />
          }
        >
          {copied ? <Check variant="bold" /> : <CopyIcon variant="bold" />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy command"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function InstallPrompt({
  mode,
  onRetry,
}: {
  readonly mode: BrowserState["mode"];
  readonly onRetry: () => void;
}) {
  const commands = installCommands(mode);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Globe variant="bold" />
        </EmptyMedia>
        <EmptyTitle>The browser tool is not installed</EmptyTitle>
        <EmptyDescription>
          The agent drives the browser through <code className="font-mono">agent-browser</code>.{" "}
          {commands.length === 1 ? "Run this command" : "Run these commands"}, then try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-md items-stretch">
        {commands.map((entry) => (
          <CommandRow key={entry.command} command={entry.command} note={entry.note} />
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}
