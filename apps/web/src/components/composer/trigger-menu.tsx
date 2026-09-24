import type { HoneyIcon } from "@honeyicons/react";
/**
 * The floating list the `#`, `@`, `$` and `/` triggers open. It is a plain
 * positioned `listbox` — the composer owns the query and the active index, so
 * every menu shares one keyboard contract: Up/Down move, Enter picks, Escape
 * closes.
 *
 * Items may carry a `group`; a muted heading is drawn where the group changes.
 * Headings are presentation only — the active index still counts rows alone.
 *
 * A row's name is what the user picks by, so it keeps its width and the
 * description gets what is left: a skill's description is often a paragraph,
 * and given its own width it would squeeze the name out of the row entirely.
 * The full description stays on the row's tooltip.
 */

import * as React from "react";

import { cn } from "@OpenAde/ui/lib/utils";

export interface TriggerMenuItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: HoneyIcon;
  /** Heading of the run of rows this one belongs to, e.g. "Skills". */
  readonly group?: string;
}

/**
 * Scroll the `index`th row of `list` into view. Up/Down move the highlight
 * while focus stays in the textarea, so nothing else would scroll the box, and
 * Enter would pick a row the user cannot see. Headings are not rows, so rows
 * are counted by role, as the active index counts them.
 */
export const revealActiveOption = (
  list: Pick<ParentNode, "querySelectorAll"> | null,
  index: number,
): void => {
  list?.querySelectorAll('[role="option"]')[index]?.scrollIntoView({ block: "nearest" });
};

/** A menu row matches when the query is blank or any of `text` contains it. */
export const matchesQuery = (query: string, ...text: ReadonlyArray<string>): boolean => {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || text.some((part) => part.toLowerCase().includes(needle));
};

export function TriggerMenu<T extends TriggerMenuItem>({
  items,
  activeIndex,
  onSelect,
  onHover,
  emptyLabel,
  loading = false,
  label,
}: {
  readonly items: ReadonlyArray<T>;
  readonly activeIndex: number;
  readonly onSelect: (item: T) => void;
  readonly onHover: (index: number) => void;
  readonly emptyLabel: string;
  readonly loading?: boolean;
  /** Accessible name, e.g. "File mentions". */
  readonly label: string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => revealActiveOption(listRef.current, activeIndex), [activeIndex, items]);

  return (
    <div
      className="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-xl bg-popover shadow-lg"
      role="listbox"
      aria-label={label}
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {items.map((item, index) => (
          <React.Fragment key={item.id}>
            {item.group === undefined || item.group === items[index - 1]?.group ? null : (
              <div
                role="presentation"
                className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
              >
                {item.group}
              </div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              title={item.description}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left text-sm",
                index === activeIndex && "bg-hover",
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // mousedown, not click: pick before the textarea blur swallows it.
                event.preventDefault();
                onSelect(item);
              }}
            >
              {item.icon === undefined ? null : (
                <item.icon variant="bold" className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">{item.label}</span>
              {item.description === undefined ? null : (
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                  {item.description}
                </span>
              )}
            </button>
          </React.Fragment>
        ))}
        {items.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {loading ? "Searching…" : emptyLabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}
