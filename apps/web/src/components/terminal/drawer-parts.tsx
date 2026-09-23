/**
 * The terminal drawer's small pieces: its icon buttons, one tab, and the
 * message it shows in place of a terminal. Stock `Button`, `Tooltip` and
 * `Empty` parts, kept apart from the drawer's own logic.
 */

import { Button } from "@OpenAde/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type * as React from "react";

import type { TerminalTab } from "@/components/terminal/drawer-state";
import { Close, Terminal } from "@honeyicons/react";

export function IconButton({
  label,
  ariaLabel = label,
  onClick,
  disabled,
  children,
  hint,
}: {
  /** The tooltip, and the accessible name unless `ariaLabel` says more. */
  label: string;
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            tone="muted"
            size="icon-xs"
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

export function TerminalTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TerminalTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        role="tab"
        aria-selected={active}
        size="xs"
        variant={active ? "secondary" : "ghost"}
        tone={active ? "default" : "muted"}
        onClick={onSelect}
      >
        <Terminal />
        {tab.title}
        {tab.status === "exited" ? <span className="text-muted-foreground">exited</span> : null}
      </Button>
      <IconButton label="Close terminal" ariaLabel={`Close ${tab.title}`} onClick={onClose}>
        <Close />
      </IconButton>
    </div>
  );
}

export function DrawerMessage({
  title,
  message,
  action,
}: {
  title: string;
  message?: string | null;
  action?: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Terminal />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {message ? <EmptyDescription>{message}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
