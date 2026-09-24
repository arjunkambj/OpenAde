/**
 * The middle of the folder picker: the breadcrumb above, the subfolders below,
 * or a message in the list's place when there are none to show.
 *
 * All of it is presentation only — every decision (which directory, which row, what
 * a key means) is in `picker-state.ts` and lives in the dialog. The list is a
 * `listbox`: one tab stop, the keyboard moves the highlight through
 * `aria-activedescendant`, and a row is still an ordinary button so a pointer
 * can select it with one click and descend with two.
 */

import type { FsEntry } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import * as React from "react";

import { cn } from "@/lib/utils";

import { breadcrumbFor } from "./picker-state";
import { type HoneyIcon, ChevronUp, Folder } from "@honeyicons/react";

export function Breadcrumb({
  path,
  canGoUp,
  onGoUp,
  onNavigate,
}: {
  readonly path: string | null;
  readonly canGoUp: boolean;
  readonly onGoUp: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  // A deep path scrolls inside the row; keep the folder the list shows, the
  // last crumb, in view rather than the root.
  const crumbsRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const crumbs = crumbsRef.current;
    if (crumbs !== null) {
      crumbs.scrollLeft = crumbs.scrollWidth;
    }
  }, [path]);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Go to the folder above"
              disabled={!canGoUp}
              onClick={onGoUp}
            />
          }
        >
          <ChevronUp variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Folder above</TooltipContent>
      </Tooltip>
      <div ref={crumbsRef} className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {path === null
          ? null
          : breadcrumbFor(path).map((crumb, index) => (
              <React.Fragment key={crumb.path}>
                {index === 0 ? null : (
                  <span className="px-0.5 type-micro text-muted-foreground">/</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  tone="muted"
                  size="xs"
                  onClick={() => onNavigate(crumb.path)}
                >
                  {crumb.label}
                </Button>
              </React.Fragment>
            ))}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  selected,
  id,
  onSelect,
  onOpen,
}: {
  readonly entry: FsEntry;
  readonly selected: boolean;
  readonly id: string;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      title={entry.path}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none",
        "hover:bg-hover",
        selected && "bg-hover",
      )}
    >
      <Folder variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
      <span className="min-w-0 truncate type-body text-foreground">{entry.name}</span>
      {entry.isGitRepo ? (
        <span className="ml-auto shrink-0 rounded-lg bg-hover px-1 type-micro text-muted-foreground">
          git
        </span>
      ) : null}
    </button>
  );
}

/**
 * The subfolders of the current directory. `activeId` is what the container's
 * `aria-activedescendant` points at, so the highlight the arrow keys move is
 * the one a screen reader announces.
 */
export function FolderList({
  entries,
  cursor,
  idPrefix,
  onSelect,
  onOpen,
  onKeyDown,
}: {
  readonly entries: ReadonlyArray<FsEntry>;
  readonly cursor: number;
  readonly idPrefix: string;
  readonly onSelect: (index: number) => void;
  readonly onOpen: (entry: FsEntry) => void;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const active = entries[cursor];
  const listRef = React.useRef<HTMLDivElement>(null);

  // Keep the highlighted row on screen when the keyboard walks past the edge of
  // the scroll box — the pointer can see where it is going, the keyboard cannot.
  React.useEffect(() => {
    const container = listRef.current;
    const row = container?.querySelector(`#${idPrefix}-${cursor}`);
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor, idPrefix]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Subfolders"
      aria-activedescendant={active === undefined ? undefined : `${idPrefix}-${cursor}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex h-64 flex-col gap-px overflow-y-auto rounded-lg bg-muted/50 px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {entries.map((entry, index) => (
        <EntryRow
          key={entry.path}
          entry={entry}
          id={`${idPrefix}-${index}`}
          selected={index === cursor}
          onSelect={() => onSelect(index)}
          onOpen={() => onOpen(entry)}
        />
      ))}
    </div>
  );
}

/**
 * What the list's place shows when there is no list: loading, an error, an
 * offline socket or an empty folder. It keeps the list's height and surface so
 * the dialog does not jump between states.
 */
export function FolderListMessage({
  icon: Glyph,
  text,
  action,
}: {
  readonly icon: HoneyIcon;
  readonly text: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex h-64 rounded-lg bg-muted/50">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Glyph variant="bold" />
          </EmptyMedia>
          <EmptyTitle>{text}</EmptyTitle>
        </EmptyHeader>
        {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </div>
  );
}
