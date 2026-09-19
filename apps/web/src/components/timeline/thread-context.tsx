/**
 * Which thread the rows on screen belong to.
 *
 * Rows are dispatched by kind through `TimelineItemView`, and nesting (tasks,
 * work groups) recurses through the same dispatcher — so threading a thread id
 * down as a prop would touch every row component and every recursion site for
 * the sake of the one row that needs it. A context costs one wrapper.
 *
 * `null` outside a timeline: a row rendered on the fixture page has no thread
 * to fetch from, and says so by not fetching.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import * as React from "react";

const TimelineThreadContext = React.createContext<ThreadId | null>(null);

export function TimelineThreadProvider({
  threadId,
  children,
}: {
  readonly threadId: ThreadId;
  readonly children: React.ReactNode;
}) {
  return (
    <TimelineThreadContext.Provider value={threadId}>{children}</TimelineThreadContext.Provider>
  );
}

export const useTimelineThreadId = (): ThreadId | null => React.useContext(TimelineThreadContext);
