import type { HoneyIcon } from "@honeyicons/react";
/**
 * The floating list the `#` and `/` triggers open. It is a plain positioned
 * `listbox` — the composer owns the query and the active index, so both menus
 * share one keyboard contract: Up/Down move, Enter picks, Escape closes.
 */

import { cn } from "@OpenAde/ui/lib/utils";

export interface TriggerMenuItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: HoneyIcon;
}

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
  return (
    <div
      className="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-xl bg-popover shadow-lg"
      role="listbox"
      aria-label={label}
    >
      <div className="max-h-64 overflow-y-auto p-1">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
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
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.description === undefined ? null : (
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {item.description}
              </span>
            )}
          </button>
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
