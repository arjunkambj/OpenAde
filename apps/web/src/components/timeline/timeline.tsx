/**
 * The virtualized thread timeline: `ItemSnapshot[]` from the detail atom,
 * folded by `buildTimeline`, rendered through `LegendList`. Row state that
 * must survive recycling (disclosure) lives in atoms, not component state.
 *
 * The timeline answers its own keys while it is on screen:
 * `timeline.jumpToLatest` scrolls to the end the way the jump button does, and
 * `timeline.collapseAll` / `expandAll` write a disclosure override for every
 * row that folds (`disclosureIds`), nested and grouped rows included. The ids
 * come from the projection with every turn fold open, so the rows a closed
 * fold hides are opened or closed along with it.
 *
 * A turn fold changes which rows the list holds, so the projection depends on
 * the open folds (`useOpenTurnFolds`) as well as on the snapshot.
 *
 * `useSendAnchor` decides who owns the scroll: it follows the end, holds a
 * just-sent message near the top while its reply streams in, or leaves the
 * reader alone once they scroll (`send-anchor.ts`).
 */

import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { uuidV7Millis } from "@OpenAde/shared/ids";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { disclosureIds } from "@/components/timeline/disclosure";
import { ALL_FOLDS_OPEN, buildTimeline } from "@/components/timeline/fold";
import { JumpToLatest } from "@/components/timeline/jump-to-latest";
import { TimelineThreadProvider } from "@/components/timeline/thread-context";
import { TimelineRowView } from "@/components/timeline/timeline-item";
import { useSendAnchor } from "@/components/timeline/use-send-anchor";
import { useTimelineThreadValue } from "@/components/timeline/use-timeline-thread";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { turnInFlight } from "@/lib/turn";
import { useOpenTurnFolds } from "@/state/turn-folds";
import { useSetRowDisclosures } from "@/state/ui";

export function Timeline({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const listRef = React.useRef<LegendListRef>(null);
  const openFolds = useOpenTurnFolds();
  const options = React.useMemo(
    () => ({
      turnActive: turnInFlight(snapshot),
      turnStartedAt:
        snapshot.currentTurnId === null ? undefined : uuidV7Millis(snapshot.currentTurnId),
      decisions: snapshot.decisions,
      checkpoints: snapshot.checkpoints,
    }),
    [snapshot],
  );
  const projection = React.useMemo(
    () =>
      buildTimeline(snapshot.items, { ...options, isFoldOpen: (rowId) => openFolds.has(rowId) }),
    [snapshot.items, options, openFolds],
  );
  const everyDisclosure = () =>
    disclosureIds(buildTimeline(snapshot.items, { ...options, isFoldOpen: ALL_FOLDS_OPEN }));

  const thread = useTimelineThreadValue(snapshot);
  const anchor = useSendAnchor({
    listRef,
    rows: projection.rows,
    threadId: snapshot.threadId,
    turnActive: options.turnActive,
  });
  const setDisclosures = useSetRowDisclosures();
  useKeybindingCommand("timeline.jumpToLatest", anchor.jumpToLatest);
  useKeybindingCommand("timeline.collapseAll", () => setDisclosures(everyDisclosure(), false));
  useKeybindingCommand("timeline.expandAll", () => setDisclosures(everyDisclosure(), true));

  const renderItem = React.useCallback(
    ({ item }: { item: (typeof projection.rows)[number] }) => (
      <TimelineRowView row={item} childrenByParent={projection.childrenByParent} />
    ),
    [projection],
  );

  return (
    <TimelineThreadProvider value={thread}>
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
          maintainScrollAtEnd={anchor.maintainScrollAtEnd}
          anchoredEndSpace={anchor.anchoredEndSpace}
          extraData={projection.childrenByParent}
          className="min-h-0 flex-1"
          // The row gap has to be a value, not a class: the virtualizer measures
          // rows itself and a Tailwind `gap-*` it cannot read throws off
          // `estimatedItemSize`, the draw distance and the scroll anchoring — which
          // is what left blank stretches mid-scroll. LegendList warns about it too.
          // The vertical padding is a value for the same reason: scroll-to-end
          // aims at the end it computes, and a `py-*` it cannot see left the
          // last row — the working clock, the turn summary — under the fold.
          contentContainerClassName="mx-auto flex w-full max-w-[700px] flex-col px-6"
          contentContainerStyle={{ gap: 16, paddingTop: 24, paddingBottom: 24 }}
        />
        <JumpToLatest
          listRef={listRef}
          activity={snapshot.items}
          hidden={anchor.placing}
          onJump={anchor.jumpToLatest}
        />
      </div>
    </TimelineThreadProvider>
  );
}
