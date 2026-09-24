/**
 * The address bar's suggestion list: a popover under the address field with
 * the project's running dev servers, then the pages its tabs have visited
 * (`./suggestions`).
 *
 * Focus never leaves the field. The popover opens without taking it, a press
 * inside the list is kept from blurring the field, and the arrow keys move
 * the highlighted row from the field itself (`moveActive`) — so typing, Enter
 * and Escape keep working exactly as they do with the list closed.
 */
import * as React from "react";

import { Command, CommandGroup, CommandItem, CommandList } from "@OpenAde/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@OpenAde/ui/components/popover";

import type { Suggestion } from "./suggestions";
import { History, Server } from "@honeyicons/react";

/**
 * The list's value while no row is highlighted. cmdk highlights its first row
 * whenever its value is empty, and Enter would then load that row instead of
 * what was typed; a value no row has (every row's is a url) keeps it off.
 */
const NO_ROW = "-";

export interface AddressSuggestionsProps {
  readonly open: boolean;
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** The highlighted row's url; null while what was typed is what Enter loads. */
  readonly active: string | null;
  readonly onActiveChange: (url: string | null) => void;
  readonly onPick: (url: string) => void;
  /** A press outside, or Escape: the owner closes the list. */
  readonly onDismiss: () => void;
  /** The address field the list hangs under. */
  readonly children: React.ReactNode;
}

function SuggestionRow({
  suggestion,
  onPick,
}: {
  readonly suggestion: Suggestion;
  readonly onPick: (url: string) => void;
}) {
  return (
    <CommandItem value={suggestion.url} onSelect={() => onPick(suggestion.url)}>
      {suggestion.kind === "server" ? <Server variant="bold" /> : <History variant="bold" />}
      <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
      {suggestion.detail === null ? null : (
        <span className="max-w-1/2 truncate type-micro text-muted-foreground">
          {suggestion.detail}
        </span>
      )}
    </CommandItem>
  );
}

export function AddressSuggestions({
  open,
  suggestions,
  active,
  onActiveChange,
  onPick,
  onDismiss,
  children,
}: AddressSuggestionsProps) {
  const servers = suggestions.filter((suggestion) => suggestion.kind === "server");
  const pages = suggestions.filter((suggestion) => suggestion.kind === "history");

  return (
    <Popover
      open={open && suggestions.length > 0}
      onOpenChange={(next, details) => {
        // The field is the anchor; pressing it is typing, not a toggle.
        if (!next && details.reason !== "trigger-press") onDismiss();
      }}
    >
      <PopoverTrigger
        nativeButton={false}
        render={<div className="flex min-w-0 flex-1" role="presentation" tabIndex={-1} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        initialFocus={false}
        finalFocus={false}
        className="min-w-(--anchor-width)"
        onMouseDown={(event) => event.preventDefault()}
      >
        <Command
          shouldFilter={false}
          value={active ?? NO_ROW}
          onValueChange={(value) => onActiveChange(value === "" || value === NO_ROW ? null : value)}
        >
          <CommandList>
            {servers.length === 0 ? null : (
              <CommandGroup heading="Local dev servers">
                {servers.map((suggestion) => (
                  <SuggestionRow key={suggestion.url} suggestion={suggestion} onPick={onPick} />
                ))}
              </CommandGroup>
            )}
            {pages.length === 0 ? null : (
              <CommandGroup heading="History">
                {pages.map((suggestion) => (
                  <SuggestionRow key={suggestion.url} suggestion={suggestion} onPick={onPick} />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
