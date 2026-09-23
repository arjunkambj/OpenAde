/**
 * The renderer's error boundary.
 *
 * Wired as the router's `defaultErrorComponent`, so it catches a render throw
 * on any route — including one thrown above `HomeLayout`, where nothing else
 * would be left on screen. Without it a component that throws left the user
 * with the router's bare default and no way back into the app.
 *
 * `reset` re-renders the failed route, which is the right first move for the
 * transient causes (a snapshot that decoded wrong, a worker that died). The
 * link home is the escape when it is not transient.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Link } from "@tanstack/react-router";

import { AlertTriangle, Repeat } from "@honeyicons/react";

/** The first line of a thrown value, whatever it turned out to be. */
export const errorSummary = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === null || error === undefined
          ? ""
          : String(error);
  const firstLine = message.trim().split("\n", 1)[0] ?? "";
  return firstLine === "" ? "Something went wrong." : firstLine;
};

export function ErrorScreen({ error, reset }: { error: unknown; reset?: () => void }) {
  return (
    <div
      role="alert"
      className="flex h-svh flex-col items-center justify-center gap-3 bg-background px-6 text-center"
    >
      <AlertTriangle className="size-6 text-destructive" />
      <p className="type-body text-foreground">This screen could not be rendered.</p>
      <p className="max-w-lg font-mono text-xs break-words text-muted-foreground">
        {errorSummary(error)}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {reset === undefined ? null : (
          <Button type="button" variant="outline" onClick={reset}>
            <Repeat />
            Try again
          </Button>
        )}
        <Button type="button" variant="ghost" render={<Link to="/" />}>
          Back to OpenAde
        </Button>
      </div>
    </div>
  );
}
