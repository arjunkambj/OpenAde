/**
 * The virtualized thread timeline: `ItemSnapshot[]` from the detail atom,
 * folded by `buildTimeline`, rendered through `LegendList`. Row state that
 * must survive recycling (disclosure) lives in atoms, not component state.
 */

import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { uuidV7Millis } from "@OpenAde/shared/ids";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { buildTimeline } from "@/components/timeline/fold";
import { JumpToLatest } from "@/components/timeline/jump-to-latest";
import { TimelineThreadProvider } from "@/components/timeline/thread-context";
import { TimelineRowView } from "@/components/timeline/timeline-item";
import { turnInFlight } from "@/lib/turn";

export function Timeline({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const listRef = React.useRef<LegendListRef>(null);
  const projection = React.useMemo(
    () =>
      buildTimeline(snapshot.items, {
        turnActive: turnInFlight(snapshot),
        turnStartedAt:
          snapshot.currentTurnId === null ? undefined : uuidV7Millis(snapshot.currentTurnId),
        decisions: snapshot.decisions,
      }),
    [snapshot],
  );

  const renderItem = React.useCallback(
    ({ item }: { item: (typeof projection.rows)[number] }) => (
      <TimelineRowView row={item} childrenByParent={projection.childrenByParent} />
    ),
    [projection],
  );

  return (
    <TimelineThreadProvider threadId={snapshot.threadId}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LegendList
          ref={listRef}
          data={projection.rows}
          keyExtractor={(row) => row.id}
          getItemType={(row) => (row.kind === "item" ? row.item.kind : row.kind)}
          renderItem={renderItem}
          estimatedItemSize={40}
          drawDistance={500}
          recycleItems
          initialScrollAtEnd
          maintainScrollAtEnd
          extraData={projection.childrenByParent}
          className="min-h-0 flex-1"
          // The row gap has to be a value, not a class: the virtualizer measures
          // rows itself and a Tailwind `gap-*` it cannot read throws off
          // `estimatedItemSize`, the draw distance and the scroll anchoring — which
          // is what left blank stretches mid-scroll. LegendList warns about it too.
          contentContainerClassName="mx-auto flex w-full max-w-[760px] flex-col px-4 py-6"
          contentContainerStyle={{ gap: 16 }}
        />
        <JumpToLatest listRef={listRef} />
      </div>
    </TimelineThreadProvider>
  );
}
