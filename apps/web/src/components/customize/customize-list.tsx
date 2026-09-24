/**
 * The pieces every Customize tab lists its entries with: the search field, the
 * section header with its count, one card per entry, the small tag pills on a
 * card, and the message a list shows in place of cards. A new tab composes
 * these instead of restyling a list.
 */

import { Empty, EmptyDescription, EmptyHeader } from "@poseidon/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { cn } from "@poseidon/ui/lib/utils";
import type * as React from "react";

import { type HoneyIcon, Search } from "@honeyicons/react";

export function CustomizeSearch({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
}) {
  return (
    <InputGroup className="flex-1">
      <InputGroupAddon>
        <Search variant="bold" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </InputGroup>
  );
}

export function CustomizeSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number | null;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {count === null ? null : (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function CustomizeCard({
  icon: Glyph,
  title,
  tags,
  actions,
  description,
  detail,
  muted = false,
}: {
  readonly icon: HoneyIcon;
  readonly title: string;
  readonly tags?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly description?: string | undefined;
  /** A monospace line under the description — a path or a command. */
  readonly detail?: string | undefined;
  /** Dims the card, for an entry the connector will not load. */
  readonly muted?: boolean;
}) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 rounded-2xl bg-card px-4 py-3", muted && "opacity-60")}
    >
      <div className="flex items-center gap-2.5">
        <Glyph variant="bold" className="size-4 shrink-0 text-foreground/85" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {tags === undefined ? null : <div className="flex items-center gap-1.5">{tags}</div>}
        {actions}
      </div>
      {description === undefined || description === "" ? null : (
        <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
      )}
      {detail === undefined || detail === "" ? null : (
        <p className="truncate font-mono text-xs text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

export function CustomizeTag({
  children,
  mono = false,
}: {
  readonly children: React.ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground",
        mono && "font-mono",
      )}
    >
      {children}
    </span>
  );
}

/** The one-line message a list shows in place of cards, on the stock `Empty`. */
export function CustomizeEmpty({ children }: { readonly children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Case-insensitive match of `query` against any of `fields`. */
export const matchesQuery = (query: string, fields: ReadonlyArray<string | undefined>): boolean => {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    fields.some((field) => field !== undefined && field.toLowerCase().includes(needle))
  );
};
