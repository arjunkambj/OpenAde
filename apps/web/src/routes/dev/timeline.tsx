/**
 * `/dev/timeline` — the fixture page. Decodes
 * `contracts/fixtures/thread-detail-snapshot.json` (every `ItemKind` in one
 * thread) and renders it through the real `Timeline`, so row work can be
 * checked without a server. Controls:
 *
 *  - ×1 / ×10 / ×50 replicate the items with fresh ids — the ×50 case is the
 *    ~1,000-row virtualization check.
 *  - "Live turn" flips the last segment to in-progress so the unfolded work
 *    rows and the trailing "Working…" row are visible.
 *  - The theme toggle exercises both token sets.
 */

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as Schema from "effect/Schema";

import { Button } from "@OpenAde/ui/components/button";
import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { decodeItemId, decodeTurnId } from "@OpenAde/contracts/ids";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { ModeToggle } from "@/components/mode-toggle";
import { Timeline } from "@/components/timeline/timeline";

export const Route = createFileRoute("/dev/timeline")({
  component: DevTimelinePage,
});

const baseSnapshot = Schema.decodeUnknownSync(ThreadDetailSnapshot)(fixture);

/** A valid UUIDv7 clone: the last 12 nibbles become a per-copy counter. */
const copyId = (id: string, copy: number) =>
  decodeItemId(`${id.slice(0, 24)}${(copy + 1).toString(16).padStart(12, "0")}`);

const cloneItem = (item: ItemSnapshot, copy: number): ItemSnapshot => ({
  ...item,
  itemId: copyId(item.itemId, copy),
  // Children follow their own copy's parent, not copy 0's.
  parentItemId: item.parentItemId === undefined ? undefined : copyId(item.parentItemId, copy),
});

const MULTIPLIERS = [1, 10, 50] as const;

function DevTimelinePage() {
  const [multiplier, setMultiplier] = React.useState<number>(1);
  const [live, setLive] = React.useState(false);

  const snapshot = React.useMemo<ThreadDetailSnapshot>(() => {
    const items =
      multiplier === 1
        ? baseSnapshot.items
        : Array.from({ length: multiplier }, (_, copy) =>
            baseSnapshot.items.map((item) => cloneItem(item, copy)),
          ).flat();
    return {
      ...baseSnapshot,
      items,
      status: live ? "running" : baseSnapshot.status,
      currentTurnId: live
        ? decodeTurnId("0199c0de-0009-7000-8000-000000000001")
        : baseSnapshot.currentTurnId,
    };
  }, [multiplier, live]);

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4">
        <span className="type-body font-medium text-foreground">Timeline fixture</span>
        <span className="type-micro text-muted-foreground">
          {snapshot.items.length} items · every row kind
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {MULTIPLIERS.map((n) => (
            <Button
              key={n}
              type="button"
              variant={multiplier === n ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={multiplier === n}
              onClick={() => setMultiplier(n)}
            >
              ×{n}
            </Button>
          ))}
          <Button
            type="button"
            variant={live ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={live}
            onClick={() => setLive((current) => !current)}
          >
            Live turn
          </Button>
          <ModeToggle />
        </div>
      </header>
      <Timeline snapshot={snapshot} />
    </div>
  );
}
