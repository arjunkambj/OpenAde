/**
 * An icon-only copy button: the Copy icon turns into a check for a moment
 * after the text reaches the clipboard, and its tooltip says "Copied". A
 * command the user is told to run and a code block in the timeline both copy
 * through it.
 */
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { Check, Copy as CopyIcon } from "@honeyicons/react";

export function CopyButton({
  text,
  label,
  tooltip = "Copy",
  tone = "default",
}: {
  readonly text: string;
  /** The button's accessible name, e.g. "Copy npm test". */
  readonly label: string;
  readonly tooltip?: string;
  /** `muted` for a button in secondary chrome, beside muted text. */
  readonly tone?: "default" | "muted";
}) {
  const [copied, setCopied] = React.useState(false);

  // The tick resets itself; clearing on unmount keeps the timer from setting
  // state on a button that has already gone.
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            tone={tone}
            size="icon-xs"
            onClick={copy}
            aria-label={label}
          />
        }
      >
        {copied ? <Check variant="bold" /> : <CopyIcon variant="bold" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : tooltip}</TooltipContent>
    </Tooltip>
  );
}
