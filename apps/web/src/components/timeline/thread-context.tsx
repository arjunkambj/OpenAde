/**
 * Which thread the rows on screen belong to, its project, and what a row
 * needs to offer a restore: the pair a row needs to read the thread's
 * workspace (`files.stat` for file chips), the checkpoints still in the
 * repository, the order of the thread's turns, and why a restore cannot
 * start right now (`use-timeline-thread.ts` derives all of it from the
 * snapshot).
 *
 * Rows are dispatched by kind through `TimelineItemView`, and nesting (tasks,
 * work groups) recurses through the same dispatcher — so threading a thread id
 * down as a prop would touch every row component and every recursion site for
 * the sake of the few rows that need it. A context costs one wrapper. Its
 * value only changes when a turn starts or ends, a checkpoint lands, or the
 * connection drops — never on a streamed delta.
 *
 * `null` outside a timeline: a row rendered on the fixture page has no thread
 * to fetch from, and says so by not fetching.
 */

import type { ProjectId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import * as React from "react";

export interface TimelineThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The fold's checkpoints that `checkpoints.list` still has. */
  readonly checkpoints: ReadonlyArray<CheckpointSummary>;
  /** Why no restore can start now (offline, restoring, a turn running), else `null`. */
  readonly restoreBlockedReason: string | null;
  /** The thread's turn ids, first seen first (`turn-checkpoints.ts`). */
  readonly turnOrder: ReadonlyArray<TurnId>;
}

const TimelineThreadContext = React.createContext<TimelineThread | null>(null);

export function TimelineThreadProvider({
  value,
  children,
}: {
  /** Memoised by the caller: every row reading the context rerenders when it changes. */
  readonly value: TimelineThread;
  readonly children: React.ReactNode;
}) {
  return <TimelineThreadContext.Provider value={value}>{children}</TimelineThreadContext.Provider>;
}

export const useTimelineThread = (): TimelineThread | null =>
  React.useContext(TimelineThreadContext);

export const useTimelineThreadId = (): ThreadId | null => useTimelineThread()?.threadId ?? null;
