/**
 * The `/dev/changes` fixture page — loaded only in a development build.
 *
 * The git atoms need a live connection, so offline this page shows the pane's
 * "not connected" state; what it does exercise, and what a fixture is the only
 * cheap way to see, is the chrome around the diff: the turn selector over a
 * real `CheckpointSummary`, the checkpoint count, and the restore button in its
 * three states (no checkpoints, a turn running, ready).
 */

import * as React from "react";
import * as Schema from "effect/Schema";

import { Button } from "@OpenAde/ui/components/button";
import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { ChangesPane } from "@/components/panes/changes/changes-pane";
import { ModeToggle } from "@/components/mode-toggle";
import { useProjects } from "@/state/hooks";

const baseSnapshot = Schema.decodeUnknownSync(ThreadDetailSnapshot)(fixture);

const CASES = ["ready", "running", "no checkpoints"] as const;
type Case = (typeof CASES)[number];

const snapshotFor = (which: Case): ThreadDetailSnapshot => {
  if (which === "no checkpoints") {
    return { ...baseSnapshot, checkpoints: [] };
  }
  if (which === "running") {
    return { ...baseSnapshot, currentTurnId: baseSnapshot.checkpoints[0]?.turnId ?? null };
  }
  return baseSnapshot;
};

export function ChangesFixture() {
  const [which, setWhich] = React.useState<Case>("ready");
  // With a dev server running, borrow the first real project so the pane talks
  // to actual git instead of a project id nothing knows about.
  const projectId = useProjects()[0]?.projectId;
  const snapshot = React.useMemo(() => {
    const base = snapshotFor(which);
    return projectId === undefined ? base : { ...base, projectId };
  }, [which, projectId]);

  return (
    <div className="flex h-dvh flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {CASES.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={option === which ? "default" : "ghost"}
            onClick={() => setWhich(option)}
          >
            {option}
          </Button>
        ))}
        <div className="ml-auto">
          <ModeToggle />
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center px-3 type-micro text-muted-foreground">
        {projectId === undefined ? "fixture project (no server)" : `project ${projectId}`}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-96 shrink-0 border-r border-border">
          <ChangesPane snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}
