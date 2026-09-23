/**
 * One thread in the projects → threads tree, on the stock sidebar menu parts.
 *
 * Left to right: a fixed status slot, the title, and how long ago the thread
 * last moved. The slot holds the status mark from `./thread-status` — needs
 * you, plan ready, running, error — and, only when there is none, the unread
 * dot; a thread that is running or waiting says so louder than "unread" can,
 * and the title's weight still carries the unread emphasis. The slot sits
 * under the project's folder icon, so the title lines up with the project name.
 *
 * On hover the time fades and two actions take its place: archive, then the
 * overflow menu. The time is a label, not a clock: `ProjectTree` owns the one
 * minute tick and passes `now` down, so a long list runs a single interval.
 */

import { Link, useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import { SidebarMenuButton, SidebarMenuItem } from "@OpenAde/ui/components/sidebar";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { ThreadArchiveAction } from "@/components/sidebar/thread-archive-action";
import { ThreadRowMenu } from "@/components/sidebar/thread-menu";
import { isUnread, useThreadSeen } from "@/components/sidebar/thread-seen";
import { threadStatusMark } from "@/components/sidebar/thread-status";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const UNREAD_LABEL = "Updated since you last opened it";

function ThreadStatusSlot({ thread, unread }: { thread: ThreadSummary; unread: boolean }) {
  const mark = threadStatusMark(thread);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {mark !== null ? (
        <span title={mark.label} aria-label={mark.label} role="img" className="flex">
          <mark.icon className={mark.tone} />
        </span>
      ) : unread ? (
        <span
          title={UNREAD_LABEL}
          aria-label={UNREAD_LABEL}
          role="img"
          className="size-1.5 rounded-full bg-primary"
        />
      ) : null}
    </span>
  );
}

export function ThreadRow({ thread, now }: { thread: ThreadSummary; now: number }) {
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to: "/t/$threadId", params: { threadId: thread.threadId } }));
  const [seen, remember] = useThreadSeen();
  const { threadId, updatedAt } = thread;

  // The open thread is being read right now, so every event it takes is seen.
  React.useEffect(() => {
    if (active) {
      remember(threadId, updatedAt);
    }
  }, [active, threadId, updatedAt, remember]);

  const unread = !active && isUnread(seen, thread);
  const archived = thread.status === "archived";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={
          <Link
            to="/t/$threadId"
            params={{ threadId }}
            aria-current={active ? "page" : undefined}
          />
        }
      >
        <ThreadStatusSlot thread={thread} unread={unread} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate type-body",
            unread && "font-medium text-foreground",
            // Archiving is a real state change that the row otherwise showed
            // nothing for: `threadStatusMark` has no mark for it by design.
            // Only the open thread can be listed while archived.
            archived && "text-muted-foreground italic",
          )}
          title={archived ? `${thread.title} (archived)` : undefined}
        >
          {thread.title}
        </span>
        <time
          dateTime={updatedAt}
          title={new Date(updatedAt).toLocaleString()}
          className="shrink-0 type-micro text-muted-foreground tabular-nums transition-opacity duration-150 ease-out group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-data-popup-open/menu-item:opacity-0 max-md:hidden"
        >
          {relativeTime(now, updatedAt)}
        </time>
      </SidebarMenuButton>
      <ThreadArchiveAction thread={thread} />
      {/* The overflow menu brings its own trigger button, so it rides in a
          plain slot with the same reveal as the stock action beside it (on
          a narrow screen both stay shown and the time steps aside), plus
          a hold while its popup is open — base-ui moves focus into the
          portalled menu, so `focus-within` on this row is false the whole
          time it is. */}
      <span className="absolute top-0.5 right-0.5 flex transition-opacity duration-150 ease-out group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 has-data-popup-open:opacity-100 md:opacity-0">
        <ThreadRowMenu thread={thread} />
      </span>
    </SidebarMenuItem>
  );
}
