/**
 * The timeline fixture's header: which scenario, how many copies, and the
 * buttons that drive a turn — Live turn, Stream, Send — plus the narrow-pane
 * toggle and the theme. State lives in the page; this only draws it.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Separator } from "@OpenAde/ui/components/separator";
import type * as React from "react";

import { ModeToggle } from "@/components/mode-toggle";

const SCENARIOS = [
  { id: "every-kind", label: "Every kind" },
  { id: "conversation", label: "Conversation" },
] as const;

export type Scenario = (typeof SCENARIOS)[number]["id"];

const MULTIPLIERS = [1, 10, 50] as const;

export interface TimelineFixtureControlsProps {
  readonly scenario: Scenario;
  readonly multiplier: number;
  readonly onLoad: (scenario: Scenario, multiplier: number) => void;
  readonly itemCount: number;
  /** The last command the page dispatched, with its receipt. */
  readonly lastDispatch: string | null;
  readonly running: boolean;
  readonly onLive: () => void;
  readonly streaming: boolean;
  readonly onStream: () => void;
  readonly onSend: () => void;
  readonly narrow: boolean;
  readonly onNarrow: () => void;
}

/** A button that reads as pressed while `on`. */
function ToggleButton({
  on,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={on ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={on}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function TimelineFixtureControls(props: TimelineFixtureControlsProps) {
  const { scenario, multiplier, onLoad } = props;
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <span className="type-body font-medium text-foreground">Timeline fixture</span>
      <span className="type-micro text-muted-foreground">{props.itemCount} items</span>
      {props.lastDispatch === null ? null : (
        <span role="status" className="min-w-0 truncate type-micro text-muted-foreground">
          Dispatched {props.lastDispatch}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {SCENARIOS.map((option) => (
          <ToggleButton
            key={option.id}
            on={scenario === option.id}
            onClick={() => onLoad(option.id, multiplier)}
          >
            {option.label}
          </ToggleButton>
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        {MULTIPLIERS.map((n) => (
          <ToggleButton key={n} on={multiplier === n} onClick={() => onLoad(scenario, n)}>
            ×{n}
          </ToggleButton>
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        <ToggleButton on={props.running} onClick={props.onLive}>
          Live turn
        </ToggleButton>
        <ToggleButton on={props.streaming} onClick={props.onStream}>
          Stream
        </ToggleButton>
        <Button type="button" variant="ghost" size="sm" onClick={props.onSend}>
          Send
        </Button>
        <ToggleButton on={props.narrow} onClick={props.onNarrow}>
          Narrow
        </ToggleButton>
        <ModeToggle />
      </div>
    </header>
  );
}
