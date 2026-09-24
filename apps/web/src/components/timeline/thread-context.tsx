/**
 * Which thread the rows on screen belong to, and its project — the pair a
 * row needs to read the thread's workspace (`files.stat` for file chips).
 *
 * Rows are dispatched by kind through `TimelineItemView`, and nesting (tasks,
 * work groups) recurses through the same dispatcher — so threading a thread id
 * down as a prop would touch every row component and every recursion site for
 * the sake of the one row that needs it. A context costs one wrapper.
 *
 * `null` outside a timeline: a row rendered on the fixture page has no thread
 * to fetch from, and says so by not fetching.
 */

import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import * as React from "react";

export interface TimelineThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

const TimelineThreadContext = React.createContext<TimelineThread | null>(null);

export function TimelineThreadProvider({
  threadId,
  projectId,
  children,
}: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ threadId, projectId }), [threadId, projectId]);
  return <TimelineThreadContext.Provider value={value}>{children}</TimelineThreadContext.Provider>;
}

export const useTimelineThread = (): TimelineThread | null =>
  React.useContext(TimelineThreadContext);

export const useTimelineThreadId = (): ThreadId | null => useTimelineThread()?.threadId ?? null;
