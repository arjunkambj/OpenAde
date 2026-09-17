/**
 * The `/dev/timeline` fixture page — loaded only in a development build. Decodes
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

import * as React from "react";
import * as Schema from "effect/Schema";

import { Button } from "@OpenAde/ui/components/button";
import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { decodeTurnId } from "@OpenAde/contracts/ids";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { ModeToggle } from "@/components/mode-toggle";
import { Timeline } from "@/components/timeline/timeline";
import { cloneItems } from "@/lib/fixture-clone";

const baseSnapshot = Schema.decodeUnknownSync(ThreadDetailSnapshot)(fixture);

const MULTIPLIERS = [1, 10, 50] as const;

export function TimelineFixture() {
  const [multiplier, setMultiplier] = React.useState<number>(1);
  const [live, setLive] = React.useState(false);

  const snapshot = React.useMemo<ThreadDetailSnapshot>(() => {
    return {
      ...baseSnapshot,
      items: cloneItems(baseSnapshot.items, multiplier),
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
