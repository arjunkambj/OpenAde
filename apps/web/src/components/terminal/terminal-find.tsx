/**
 * Find in the terminal: a stock `InputGroup` on a row under the drawer's
 * toolbar that searches the xterm in front as the user types. Enter steps to
 * the next match, Shift+Enter to the previous one, and Escape closes it — the
 * drawer then puts focus back in the terminal.
 *
 * It sits inside the drawer's `data-context="terminal"`, so Escape here is
 * never taken for `thread.interrupt`; see `@/lib/shortcuts`.
 */

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@OpenAde/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import type { FindResults, TerminalHandle } from "@/components/terminal/terminal-handle";
import { ChevronDown, ChevronUp, Close, Search } from "@honeyicons/react";

function FindButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InputGroupButton
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** "3/12", "12 matches" past the highlight limit, or "0/0" for none. */
const describeResults = (results: FindResults): string =>
  results.index === -1 && results.count > 0
    ? `${results.count} matches`
    : `${results.index + 1}/${results.count}`;

export function TerminalFind({ handle, onClose }: { handle: TerminalHandle; onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<FindResults | null>(null);

  React.useEffect(() => handle.watchFindResults(setResults), [handle]);
  // Closing find, or the xterm going away, takes the highlights with it.
  React.useEffect(() => () => handle.clearFind(), [handle]);

  const step = (direction: "next" | "previous") => {
    if (query !== "") {
      handle.find(query, direction);
    }
  };

  const onChange = (next: string) => {
    setQuery(next);
    if (next === "") {
      handle.clearFind();
      setResults(null);
    } else {
      handle.find(next, "next", true);
    }
  };

  return (
    <InputGroup className="h-7 max-w-72">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        autoFocus
        aria-label="Find in terminal"
        placeholder="Find"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        {query !== "" && results !== null ? (
          <InputGroupText>{describeResults(results)}</InputGroupText>
        ) : null}
        <FindButton label="Previous match" disabled={query === ""} onClick={() => step("previous")}>
          <ChevronUp />
        </FindButton>
        <FindButton label="Next match" disabled={query === ""} onClick={() => step("next")}>
          <ChevronDown />
        </FindButton>
        <FindButton label="Close find" onClick={onClose}>
          <Close />
        </FindButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
