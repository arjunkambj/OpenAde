/**
 * Which paths a row names are files in the thread's workspace, for the rows
 * that turn them into chips: markdown bodies, file changes and read targets.
 * The turn summary's file list resolves its paths here too, to label each
 * one relative to the workspace, but draws no chips: its lines open Changes.
 *
 * `PathChipsProvider` asks once for the row's candidates (`usePathChips`) and
 * provides the confirmed files; `PathChip` shows one path as its chip once
 * confirmed and as `fallback` until then — and for good, when the workspace
 * does not have it. Outside a timeline nothing is asked and nothing is a chip.
 */

import * as React from "react";

import { FileChip } from "@/components/timeline/file-chip";
import type { ConfirmedFile, PathLink } from "@/components/timeline/path-links";
import { type TimelineThread, useTimelineThread } from "@/components/timeline/thread-context";
import { usePathChips } from "@/components/timeline/use-path-chips";

const noFiles: ReadonlyMap<string, ConfirmedFile> = new Map();

/** The confirmed files among the row's candidates, keyed by the candidate. */
export const PathChipsContext = React.createContext<ReadonlyMap<string, ConfirmedFile>>(noFiles);

function ThreadPathChips({
  thread,
  candidates,
  children,
}: {
  readonly thread: TimelineThread;
  readonly candidates: ReadonlyArray<string>;
  readonly children: React.ReactNode;
}) {
  const files = usePathChips(thread, candidates);
  return <PathChipsContext.Provider value={files}>{children}</PathChipsContext.Provider>;
}

export function PathChipsProvider({
  candidates,
  children,
}: {
  readonly candidates: ReadonlyArray<string>;
  readonly children: React.ReactNode;
}) {
  const thread = useTimelineThread();
  // Branch on the thread only, which a row keeps for its life: switching on
  // the candidates would remount the children each time a streaming message
  // gained its first path.
  if (thread === null) {
    return <>{children}</>;
  }
  return (
    <ThreadPathChips thread={thread} candidates={candidates}>
      {children}
    </ThreadPathChips>
  );
}

/** One path a tool row names: its chip once confirmed, `fallback` otherwise. */
export function PathChip({
  path,
  position,
  fallback,
  className,
}: {
  /** The path exactly as the row's provider asked about it. */
  readonly path: string;
  readonly position?: Pick<PathLink, "line" | "column" | "endLine">;
  readonly fallback: React.ReactNode;
  readonly className?: string;
}) {
  const file = React.useContext(PathChipsContext).get(path);
  if (file === undefined) {
    return <>{fallback}</>;
  }
  return (
    <FileChip
      file={file}
      display="path"
      className={className}
      {...(position ? { position } : {})}
    />
  );
}
