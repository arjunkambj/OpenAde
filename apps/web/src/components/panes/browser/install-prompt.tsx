/**
 * What the pane shows when the browser tool is missing: the two commands to
 * run, each copyable, and a retry that asks the server to open the browser
 * again (a reload gesture with no driver open starts one).
 *
 * This replaces the error string being squeezed into the toolbar chip — the
 * one failure the user can actually fix deserves the whole surface.
 */
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";

import { Icon } from "@/lib/icon";
import { INSTALL_COMMANDS } from "./install";

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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label={`Copy ${command}`}
      >
        <Icon icon={copied ? "hugeicons:tick-02" : "hugeicons:copy-01"} className="size-4" />
      </Button>
    </div>
  );
}

export function InstallPrompt({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-md flex-col gap-3">
        <div className="flex items-center gap-2">
          <Icon icon="hugeicons:globe-02" className="size-5 text-muted-foreground" />
          <h2 className="type-body font-medium">The browser tool is not installed</h2>
        </div>
        <p className="type-body text-muted-foreground">
          Threads drive a real browser through <code className="font-mono">agent-browser</code>. Run
          these two commands, then try again.
        </p>
        <div className="flex flex-col gap-1.5">
          {INSTALL_COMMANDS.map((entry) => (
            <CommandRow key={entry.command} command={entry.command} note={entry.note} />
          ))}
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
