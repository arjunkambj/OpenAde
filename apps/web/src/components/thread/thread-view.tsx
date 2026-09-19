/**
 * The center column of `/t/$threadId`: a slim header (title, status, the model
 * / effort / mode controls, dock toggle) over the virtualized `Timeline`, with
 * the composer — and the interaction cards it carries — pinned underneath and
 * the right dock alongside. Data comes from `useThreadDetail` — an
 * `AsyncResult` that carries its own loading/failure states, so the view never
 * has to know whether the socket is mid-resnapshot.
 *
 * `browserPane.toggle` is claimed here because it needs the thread's dock. The
 * rest of the thread-scoped bindings — `thread.interrupt`, `composer.queue` and
 * the `threadRunning` flag — belong to the composer, which owns the Stop button
 * and the error line those bindings report through. The layout keeps the
 * bindings that work with no thread open.
 */

import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import type { ThreadStatus } from "@OpenAde/contracts/orchestration";
import type * as OpenAdeRpcError from "@OpenAde/contracts/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { Composer } from "@/components/composer/composer";
import { isDockTab, RightDock, type DockTab } from "@/components/dock/right-dock";
import { HeaderControls } from "@/components/header-controls";
import { ThreadGreeting } from "@/components/thread/thread-greeting";
import { Timeline } from "@/components/timeline/timeline";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadDetail } from "@/state/hooks";
import { useDockTabMemory } from "@/state/ui";
import { AlertTriangle, Close, SidebarRight, Spinner } from "@honeyicons/react";

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
      {status === "running" ? <Spinner className="size-3" /> : null}
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
    <header className="flex min-h-11 shrink-0 items-center gap-2 px-4 py-1.5">
      <h1 className="min-w-0 max-w-56 shrink truncate text-sm font-medium text-foreground">
        {snapshot.title}
      </h1>
      {/* The pickers carry their own "applies next turn" hints, so the row can
          be wider than the header — especially with the dock open. Scroll it
          instead of letting the pickers wrap into the title or squeeze their
          labels to nothing. */}
      <HeaderControls
        threadId={snapshot.threadId}
        className="min-w-0 flex-1 flex-nowrap overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0"
      />
      <StatusPill status={snapshot.status} />
      <span className="inline-flex shrink-0">
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
            <SidebarRight className={cn(dockTab !== undefined && "text-foreground")} />
          </TooltipTrigger>
          <TooltipContent>{dockTab === undefined ? "Open dock" : "Close dock"}</TooltipContent>
        </Tooltip>
      </span>
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

/** A fresh thread: the greeting, for the project the thread belongs to. */
function EmptyThread({ projectId }: { projectId: ThreadDetailSnapshot["projectId"] }) {
  const project = useProjects().find((entry) => entry.projectId === projectId);
  return <ThreadGreeting project={project} />;
}

function ThreadBody({ result, connected }: { result: ThreadDetailResult; connected: boolean }) {
  const snapshot = snapshotOf(result);
  if (snapshot !== null) {
    if (snapshot.items.length === 0) {
      return <EmptyThread projectId={snapshot.projectId} />;
    }
    return <Timeline snapshot={snapshot} />;
  }
  if (AsyncResult.isFailure(result)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle className="size-5 text-destructive" />
        <p className="type-body text-muted-foreground">{failureMessage(result)}</p>
      </div>
    );
  }
  // No server resolved at all — the subscription never starts, so say so
  // instead of spinning on a load that cannot finish.
  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Close className="size-5 text-muted-foreground" />
        <p className="type-body text-muted-foreground">Not connected to a server.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center gap-2 type-body text-muted-foreground">
      <Spinner className="size-4" />
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

  const [dockTabs, rememberDockTab] = useDockTabMemory();

  const setDockTab = React.useCallback(
    (tab: DockTab | null) => {
      rememberDockTab(threadId, tab);
      void navigate({
        to: "/t/$threadId",
        params: { threadId },
        search: { pane: tab ?? undefined },
        replace: true,
      });
    },
    [navigate, rememberDockTab, threadId],
  );

  // Arriving with no `?pane=` — a sidebar link, a relaunch — restores the tab
  // this thread was last left on. Closing the dock forgets it, so this cannot
  // re-open what the user just closed.
  const remembered = dockTabs[threadId];
  React.useEffect(() => {
    if (dockTab === undefined && isDockTab(remembered)) {
      void navigate({
        to: "/t/$threadId",
        params: { threadId },
        search: { pane: remembered },
        replace: true,
      });
    }
  }, [dockTab, navigate, remembered, threadId]);

  const snapshot = snapshotOf(result);

  // The client fold turns `thread.deleted` into this status for exactly this
  // purpose: the server drops a deleted thread from the read model, so the only
  // thing left to do with an open timeline is leave it.
  const deleted = snapshot?.status === "deleted";
  React.useEffect(() => {
    if (deleted) {
      void navigate({ to: "/" });
    }
  }, [deleted, navigate]);

  // `thread.interrupt`, `composer.queue` and the `threadRunning` flag belong to
  // the `Composer` below, not here. Both components used to register all three,
  // and which one won depended on whether the thread detail was already cached
  // at first paint — so Escape either showed the Stop button's "Stopping…"
  // state and reported a rejected interrupt, or did neither, on the same
  // thread. The composer is the surface with the visible Stop button and the
  // error line, so it is the one that answers. This keeps the dock toggle,
  // which is the only one of the four that is really this component's.
  useKeybindingCommand("browserPane.toggle", () =>
    setDockTab(dockTab === "browser" ? null : "browser"),
  );

  return (
    // The dock overlays when this row cannot fit both columns, including
    // when a wide sidebar leaves little space in a desktop window.
    <div className="@container/thread relative flex min-h-0 min-w-0 flex-1">
      {/* The thread column's floor (`THREAD_COLUMN_MIN`); the dock's width
          bound yields to it when there is room for a 280px dock beside it. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col @min-[640px]/thread:min-w-90">
        {snapshot !== null ? (
          <ThreadHeader
            snapshot={snapshot}
            dockTab={dockTab}
            onDockToggle={() => setDockTab(dockTab === undefined ? "changes" : null)}
          />
        ) : null}
        <ThreadBody result={result} connected={connection.status !== "disconnected"} />
        {snapshot !== null ? (
          <div className="flex w-full shrink-0 justify-center px-4 pb-4">
            <Composer threadId={threadId} projectId={snapshot.projectId} />
          </div>
        ) : null}
      </section>
      {dockTab !== undefined && snapshot !== null ? (
        <RightDock tab={dockTab} onTabChange={setDockTab} snapshot={snapshot} />
      ) : null}
    </div>
  );
}
