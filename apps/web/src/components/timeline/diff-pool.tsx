/**
 * Diff rendering for `file_change` rows: `PatchDiff` over a shared worker pool
 * so highlighting never runs on the main thread. The pool is initialized with
 * both bundled themes; each diff picks via `themeType`, so theme switches need
 * no worker round-trip.
 */

import { PatchDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as React from "react";

import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

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

export function InlineDiff({ patch, className }: { patch: string; className?: string }) {
  const { resolvedTheme } = useTheme();
  const options = React.useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      theme: DIFF_THEMES,
      themeType: resolvedTheme === "dark" ? "dark" : "light",
      diffStyle: "unified",
      disableFileHeader: true,
      overflow: "scroll",
    }),
    [resolvedTheme],
  );
  return (
    <PatchDiff
      patch={patch}
      options={options}
      className={cn("overflow-hidden rounded-lg text-xs", className)}
    />
  );
}
