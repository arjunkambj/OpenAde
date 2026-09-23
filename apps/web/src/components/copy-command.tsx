/**
 * A shell command the user is told to run, in a mono code span with a copy
 * button beside it. The settings card and the harness banner show the
 * connector's own login or install command through it.
 */
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";

import { Check, Copy as CopyIcon } from "@honeyicons/react";

export function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = React.useState(false);

  // The tick resets itself; clearing on unmount keeps the timer from setting
  // state on a card or banner that has already gone.
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
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        aria-label={`Copy ${command}`}
      >
        {copied ? <Check /> : <CopyIcon />}
      </Button>
    </span>
  );
}
