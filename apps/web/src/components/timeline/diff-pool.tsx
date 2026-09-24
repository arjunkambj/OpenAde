/**
 * Diff rendering for `file_change` rows: `PatchDiff` over a shared worker pool
 * so highlighting never runs on the main thread. The pool is initialized with
 * both bundled themes; each diff picks via `themeType`, so theme switches need
 * no worker round-trip.
 */

import { PatchDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as React from "react";

import { useTheme } from "@/components/theme-provider";
import { hasHunkHeader } from "@/lib/diff-stats";
import { cn } from "@/lib/utils";
import type { DiffStyle } from "@/state/ui";

import { DIFF_THEMES, inlineDiffOptions } from "./diff-options";

const poolOptions = {
  workerFactory: () => new DiffsWorker(),
  poolSize: 2,
};

const highlighterOptions = { theme: DIFF_THEMES };

export function DiffWorkerPoolProvider({ children }: { children: React.ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

/** `diffStyle` defaults to unified; only the Changes pane offers split. */
export function InlineDiff({
  patch,
  className,
  diffStyle,
}: {
  patch: string;
  className?: string;
  diffStyle?: DiffStyle;
}) {
  const { resolvedTheme } = useTheme();
  const options = React.useMemo(
    () => inlineDiffOptions(resolvedTheme === "dark" ? "dark" : "light", diffStyle),
    [resolvedTheme, diffStyle],
  );
  // `PatchDiff` renders an empty element for a patch it cannot parse, which
  // reads exactly like "no changes". Show the text the server actually sent
  // instead — a malformed or truncated patch is information, not silence.
  if (!hasHunkHeader(patch)) {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-lg bg-hover px-2.5 py-1.5 font-mono text-xs whitespace-pre text-muted-foreground",
          className,
        )}
      >
        {patch}
      </pre>
    );
  }
  return (
    <PatchDiff
      patch={patch}
      options={options}
      className={cn("overflow-hidden rounded-lg text-xs", className)}
    />
  );
}
