/**
 * The pane's toolbar: back/forward/reload — stop while the page loads — as
 * human gestures (each bumps the epoch, so they interrupt an in-flight agent
 * call), an address field that mirrors the live url and navigates on Enter,
 * and the status chip that shows who is driving — `agent: browser_click`
 * while a `browser_*` call runs. What is typed goes through `./address`: only
 * an http(s) url or `about:blank` is ever loaded.
 */
import * as React from "react";

import type { BrowserHumanInput, BrowserState } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { Input } from "@OpenAde/ui/components/input";

import { cn } from "@/lib/utils";
import { normalizeAddress } from "./address";
import { browserStatus } from "./status";
import { ChevronLeft, ChevronRight, Repeat, Stop } from "@honeyicons/react";

/** What the in-app pane knows about the selected tab's history. */
export interface TabNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
}

export interface AddressBarProps {
  readonly state: BrowserState | null;
  /**
   * The url to show when the pane knows it better than the server does — the
   * in-app pane's selected tab. Absent, the server's url is shown.
   */
  readonly url?: string | undefined;
  /** The selected tab's history, in-app; absent, every button is live. */
  readonly nav?: TabNavigation | undefined;
  readonly onAction: (input: BrowserHumanInput) => void;
  /** The address field, for `browser.focusAddress`. */
  readonly inputRef?: React.Ref<HTMLInputElement>;
  /** Trailing controls: the in-app pane's zoom and "more" menu. */
  readonly children?: React.ReactNode;
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function AddressBar({ state, url, nav, onAction, inputRef, children }: AddressBarProps) {
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const displayUrl = url ?? state?.url ?? "";
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
    const target = normalizeAddress(value);
    if (target !== null) onAction({ kind: "navigate", url: target });
    setEditing(false);
  };

  const history = (direction: "back" | "forward" | "reload" | "stop") => () =>
    onAction({ kind: "history", direction });

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <ToolbarButton label="Back" disabled={nav?.canGoBack === false} onClick={history("back")}>
        <ChevronLeft variant="bold" />
      </ToolbarButton>
      <ToolbarButton
        label="Forward"
        disabled={nav?.canGoForward === false}
        onClick={history("forward")}
      >
        <ChevronRight variant="bold" />
      </ToolbarButton>
      {nav?.loading === true ? (
        <ToolbarButton label="Stop" onClick={history("stop")}>
          <Stop variant="bold" />
        </ToolbarButton>
      ) : (
        <ToolbarButton label="Reload" onClick={history("reload")}>
          <Repeat variant="bold" />
        </ToolbarButton>
      )}
      <Input
        ref={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setEditing(true);
        }}
        onBlur={() => setEditing(false)}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
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
      {children}
    </div>
  );
}
