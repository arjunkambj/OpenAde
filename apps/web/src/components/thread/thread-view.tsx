/**
 * The center column of `/t/$threadId`: a slim header (title, status, dock
 * toggle) over the virtualized `Timeline`, with the right dock alongside.
 * Data comes from `useThreadDetail` — an `AsyncResult` that carries its own
 * loading/failure states, so the view never has to know whether the socket is
 * mid-resnapshot.
 */

import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import type { ThreadStatus } from "@OpenAde/contracts/orchestration";
import type * as OpenAdeRpcError from "@OpenAde/contracts/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { RightDock, type DockTab } from "@/components/dock/right-dock";
import { Timeline } from "@/components/timeline/timeline";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { useConnectionState, useThreadDetail } from "@/state/hooks";

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  error: "Error",
  archived: "Archived",
  deleted: "Deleted",
};

function StatusPill({ status }: { status: ThreadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 type-micro",
        (status === "error" || status === "deleted") && "bg-removed-bg text-removed",
        status === "waiting" && "text-permission",
        (status === "idle" || status === "archived") && "text-muted-foreground",
      )}
    >
      {status === "running" ? (
        <Icon icon="hugeicons:loading-03" className="size-3 animate-spin" />
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

function ThreadHeader({
  snapshot,
  dockTab,
  onDockToggle,
}: {
  snapshot: ThreadDetailSnapshot;
  dockTab: DockTab | undefined;
  onDockToggle: () => void;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {snapshot.title}
      </h1>
      <StatusPill status={snapshot.status} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={dockTab === undefined ? "Open dock" : "Close dock"}
              aria-pressed={dockTab !== undefined}
              onClick={onDockToggle}
            />
          }
        >
          <Icon
            icon="hugeicons:layout-right"
            className={cn(dockTab !== undefined && "text-foreground")}
          />
        </TooltipTrigger>
        <TooltipContent>{dockTab === undefined ? "Open dock" : "Close dock"}</TooltipContent>
      </Tooltip>
    </header>
  );
}

type ThreadDetailResult = AsyncResult.AsyncResult<
  ThreadDetailSnapshot,
  OpenAdeRpcError.OpenAdeRpcError | RpcClientError.RpcClientError | Cause.NoSuchElementError
>;

/** First squashed error line, or the generic fallback when the cause is empty. */
function failureMessage(result: ThreadDetailResult): string {
  if (!AsyncResult.isFailure(result)) {
    return "Could not load this thread.";
  }
  const pretty = Cause.pretty(result.cause).trim();
  const firstLine = pretty.split("\n", 1)[0];
  return firstLine === "" ? "Could not load this thread." : firstLine;
}

/**
 * The snapshot to render right now: the current value on success, or the last
 * good one a failed refresh kept. A failed refresh should not blank the
 * timeline — the connection banner already explains the retry.
 */
const snapshotOf = (result: ThreadDetailResult): ThreadDetailSnapshot | null => {
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  if (AsyncResult.isFailure(result) && result.previousSuccess._tag === "Some") {
    return result.previousSuccess.value.value;
  }
  return null;
};

function ThreadBody({ result, connected }: { result: ThreadDetailResult; connected: boolean }) {
  const snapshot = snapshotOf(result);
  if (snapshot !== null) {
    if (snapshot.items.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="type-body text-muted-foreground">
            No messages yet — send one to start the turn.
          </p>
        </div>
      );
    }
    return <Timeline snapshot={snapshot} />;
  }
  if (AsyncResult.isFailure(result)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon="hugeicons:alert-02" className="size-5 text-destructive" />
        <p className="type-body text-muted-foreground">{failureMessage(result)}</p>
      </div>
    );
  }
  // No server resolved at all — the subscription never starts, so say so
  // instead of spinning on a load that cannot finish.
  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon="hugeicons:wifi-off-01" className="size-5 text-muted-foreground" />
        <p className="type-body text-muted-foreground">Not connected to a server.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center gap-2 type-body text-muted-foreground">
      <Icon icon="hugeicons:loading-03" className="size-4 animate-spin" />
      Loading thread…
    </div>
  );
}

export function ThreadView({
  threadId,
  dockTab,
}: {
  threadId: ThreadId;
  dockTab: DockTab | undefined;
}) {
  const result = useThreadDetail(threadId);
  const connection = useConnectionState();
  const navigate = useNavigate();

  const setDockTab = (tab: DockTab | null) => {
    void navigate({
      to: "/t/$threadId",
      params: { threadId },
      search: { pane: tab ?? undefined },
      replace: true,
    });
  };

  const snapshot = snapshotOf(result);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {snapshot !== null ? (
          <ThreadHeader
            snapshot={snapshot}
            dockTab={dockTab}
            onDockToggle={() => setDockTab(dockTab === undefined ? "changes" : null)}
          />
        ) : null}
        <ThreadBody result={result} connected={connection.status !== "disconnected"} />
      </section>
      {dockTab !== undefined && snapshot !== null ? (
        <RightDock tab={dockTab} onTabChange={setDockTab} snapshot={snapshot} />
      ) : null}
    </div>
  );
}
