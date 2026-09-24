/**
 * The center column of `/t/$threadId`: a slim header (`thread-header.tsx`:
 * title, worktree, status, dock toggle) over the virtualized `Timeline`, with
 * the composer — and the interaction cards it carries — pinned underneath and
 * the right dock alongside. Data comes from `useThreadDetail` — an
 * `AsyncResult` that carries its own loading/failure states, so the view never
 * has to know whether the socket is mid-resnapshot.
 *
 * `browserPane.toggle` is claimed here because it needs the thread's dock. The
 * rest of the thread-scoped bindings — `thread.interrupt`, `composer.queue` and
 * the `turnRunning` flag — belong to the composer, which owns the Stop button
 * and the error line those bindings report through. The layout keeps the
 * bindings that work with no thread open. The terminal drawer sits in the
 * thread column below the composer and answers `terminal.toggle` itself; the
 * links it opens land on this dock's Browser tab. This view publishes
 * `threadOpen` while it is mounted and `dockOpen` while the right dock is, and
 * mounts `ThreadShortcuts` — rename, archive and delete for this thread — once
 * the snapshot is in.
 */

import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import * as React from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import type * as OpenAdeRpcError from "@OpenAde/contracts/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { Composer } from "@/components/composer/composer";
import { isDockTab, RightDock, type DockTab } from "@/components/dock/right-dock";
import { ThreadTerminal } from "@/components/terminal/terminal-drawer";
import { ThreadHarnessBanner } from "@/components/thread/harness-health-banner";
import { ThreadHeader } from "@/components/thread/thread-header";
import { ThreadGreeting } from "@/components/thread/thread-greeting";
import { ThreadShortcuts } from "@/components/thread/thread-shortcuts";
import { Timeline } from "@/components/timeline/timeline";
import { useKeybindingCommand, useKeybindingFlag } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadDetail } from "@/state/hooks";
import { useDockTabMemory } from "@/state/ui";
import { AlertTriangle, Spinner, WifiOff } from "@honeyicons/react";

type ThreadDetailResult = AsyncResult.AsyncResult<
  ThreadDetailSnapshot,
  OpenAdeRpcError.OpenAdeRpcError | RpcClientError.RpcClientError | Cause.NoSuchElementError
>;

/** First squashed error line, or null when the cause says nothing. */
function failureMessage(result: ThreadDetailResult): string | null {
  if (!AsyncResult.isFailure(result)) {
    return null;
  }
  const pretty = Cause.pretty(result.cause).trim();
  const firstLine = pretty.split("\n", 1)[0];
  return firstLine === undefined || firstLine === "" ? null : firstLine;
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

/** A fresh thread: the greeting, for the project and worktree the thread works in. */
function EmptyThread({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const project = useProjects().find((entry) => entry.projectId === snapshot.projectId);
  return <ThreadGreeting project={project} worktree={snapshot.worktree} />;
}

function ThreadBody({ result, connected }: { result: ThreadDetailResult; connected: boolean }) {
  const snapshot = snapshotOf(result);
  if (snapshot !== null) {
    if (snapshot.items.length === 0) {
      return <EmptyThread snapshot={snapshot} />;
    }
    return <Timeline snapshot={snapshot} />;
  }
  if (AsyncResult.isFailure(result)) {
    const message = failureMessage(result);
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle variant="bold" className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>Could not load this thread</EmptyTitle>
          {message === null ? null : <EmptyDescription>{message}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    );
  }
  // No server resolved at all — the subscription never starts, so say so
  // instead of spinning on a load that cannot finish.
  if (!connected) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WifiOff variant="bold" />
          </EmptyMedia>
          <EmptyTitle>Not connected to a server</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center gap-2 type-body text-muted-foreground">
      <Spinner variant="bold" className="size-4" />
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

  useKeybindingFlag("threadOpen", true);
  useKeybindingFlag("dockOpen", dockTab !== undefined);

  // `thread.interrupt`, `composer.queue` and the `turnRunning` flag belong to
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
          <ThreadShortcuts threadId={threadId} title={snapshot.title} status={snapshot.status} />
        ) : null}
        {snapshot !== null ? (
          <ThreadHeader
            snapshot={snapshot}
            dockTab={dockTab}
            onDockToggle={() => setDockTab(dockTab === undefined ? "changes" : null)}
          />
        ) : null}
        <ThreadBody result={result} connected={connection.status !== "disconnected"} />
        {snapshot !== null ? (
          <div className="flex w-full shrink-0 flex-col items-center gap-2 px-4 pb-4">
            <ThreadHarnessBanner snapshot={snapshot} className="max-w-[760px]" />
            <Composer threadId={threadId} projectId={snapshot.projectId} />
          </div>
        ) : null}
        {snapshot !== null ? (
          <ThreadTerminal
            key={threadId}
            threadId={threadId}
            onShowBrowser={() => setDockTab("browser")}
          />
        ) : null}
      </section>
      {dockTab !== undefined && snapshot !== null ? (
        <RightDock tab={dockTab} onTabChange={setDockTab} snapshot={snapshot} />
      ) : null}
    </div>
  );
}
