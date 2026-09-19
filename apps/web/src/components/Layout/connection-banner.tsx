/**
 * The connection strip. What it says is decided by `connectionNotice` in
 * `@/lib/connection-status`, which weighs the websocket state against what
 * the desktop supervisor is doing with the server process — so a supervisor
 * that has given up says so instead of the socket's endless "reconnecting…".
 * This file only draws it. Hidden while there is nothing to say.
 */

import { connectionNotice } from "@/lib/connection-status";
import { useConnectionState, useDesktopServerState } from "@/state/hooks";

export function ConnectionBanner() {
  const connection = useConnectionState();
  const server = useDesktopServerState();
  const notice = connectionNotice(connection, server);

  if (notice === null) {
    return null;
  }

  const pending = notice.tone === "pending";

  return (
    <div
      role="status"
      className={
        pending
          ? "flex h-8 shrink-0 items-center justify-center gap-2 bg-secondary px-3 type-micro text-secondary-foreground"
          : "flex h-8 shrink-0 items-center justify-center gap-2 bg-removed-bg px-3 type-micro text-removed"
      }
    >
      <notice.icon className="size-3.5" />
      <span>{notice.message}</span>
    </div>
  );
}
