import type { HoneyIcon } from "@honeyicons/react";
/**
 * Shared chrome for the interaction cards that occupy the composer slot:
 * title row with icon, content area, and a footer row of actions. The cards
 * close when the matching resolved event lands in the doc — never locally —
 * so nothing here owns open/close state.
 *
 * Card parts own their own spacing and typography, so layout lives on plain
 * inner elements rather than className overrides.
 */

import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@OpenAde/ui/components/card";
import { cn } from "@OpenAde/ui/lib/utils";

export function CardShell({
  icon: Glyph,
  title,
  hint,
  actions,
  children,
  className,
}: {
  readonly icon: HoneyIcon;
  readonly title: string;
  /** Small muted text on the right of the title, e.g. the tool name. */
  readonly hint?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <Card size="sm" className={cn("w-full", className)} role="group" aria-label={title}>
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            <Glyph variant="bold" className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{title}</span>
          </span>
        </CardTitle>
        {hint === undefined ? null : (
          <CardAction>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-3">{children}</div>
      </CardContent>
      {actions === undefined ? null : (
        <CardFooter>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </CardFooter>
      )}
    </Card>
  );
}
