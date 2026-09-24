import type * as React from "react";
import { cn } from "@OpenAde/ui/lib/utils";

export const composerInputClassName =
  "field-sizing-content block max-h-64 min-h-10 w-full resize-none bg-transparent px-1 text-sm leading-6 text-foreground outline-none";

export function ComposerSurface({
  context,
  children,
  className,
  dragging,
  ...props
}: React.ComponentProps<"form"> & {
  readonly context?: React.ReactNode;
  readonly dragging?: boolean;
}) {
  return (
    <div className="w-full min-w-0">
      <form
        {...props}
        className={cn(
          "relative flex min-w-0 flex-col gap-2 rounded-3xl border border-border bg-card px-4 py-2.5 shadow-sm transition-colors focus-within:border-ring/50 focus-within:shadow-md",
          dragging && "border-primary ring-1 ring-primary",
          className,
        )}
      >
        {children}
      </form>
      {context ? (
        <div className="mx-3 flex min-h-8 min-w-0 items-center gap-3 rounded-b-2xl bg-muted px-4 py-0 text-sm text-muted-foreground sm:mx-6">
          {context}
        </div>
      ) : null}
    </div>
  );
}
