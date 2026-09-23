/**
 * The pane's toolbar: back/forward/reload as human gestures (each bumps the
 * epoch, so they interrupt an in-flight agent call), an address field that
 * mirrors the live url and navigates on Enter, and the status chip that shows
 * who is driving — `agent: browser_click` while a `browser_*` call runs.
 */
import * as React from "react";

import type { BrowserHumanInput, BrowserState } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { Input } from "@OpenAde/ui/components/input";

import { cn } from "@/lib/utils";
import { browserStatus } from "./status";
import { ChevronLeft, ChevronRight, Repeat } from "@honeyicons/react";

export interface AddressBarProps {
  readonly state: BrowserState | null;
  readonly onAction: (input: BrowserHumanInput) => void;
}

const normalizeAddress = (raw: string): string =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;

export function AddressBar({ state, onAction }: AddressBarProps) {
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const displayUrl = state?.url ?? "";
  const status = browserStatus(state);

  // The address mirrors the live url unless the human is mid-edit.
  React.useEffect(() => {
    if (!editing) setDraft(displayUrl);
  }, [displayUrl, editing]);

  const submit = () => {
    const value = draft.trim();
    if (value === "" || value === displayUrl) {
      setEditing(false);
      return;
    }
    onAction({ kind: "navigate", url: normalizeAddress(value) });
    setEditing(false);
  };

  const history = (direction: "back" | "forward" | "reload") => () =>
    onAction({ kind: "history", direction });

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" onClick={history("back")} aria-label="Back" />
          }
        >
          <ChevronLeft />
        </TooltipTrigger>
        <TooltipContent>Back</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={history("forward")}
              aria-label="Forward"
            />
          }
        >
          <ChevronRight />
        </TooltipTrigger>
        <TooltipContent>Forward</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={history("reload")}
              aria-label="Reload"
            />
          }
        >
          <Repeat />
        </TooltipTrigger>
        <TooltipContent>Reload</TooltipContent>
      </Tooltip>
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setEditing(true);
        }}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") {
            setDraft(displayUrl);
            setEditing(false);
          }
        }}
        placeholder="Search or enter address"
        spellCheck={false}
        className="h-7 flex-1"
        aria-label="Address"
      />
      <div
        className="text-muted-foreground flex max-w-[40%] items-center gap-1.5 truncate px-1 text-xs"
        title={status.label}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
        <span className="truncate">{status.label}</span>
      </div>
    </div>
  );
}
