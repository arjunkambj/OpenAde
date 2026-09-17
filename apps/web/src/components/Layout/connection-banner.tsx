/**
 * The transport state banner, driven by `connectionStateAtom`:
 *  - `connecting` / `reconnecting` — transient states get a quiet strip.
 *  - `disconnected` — no server was resolved at all; the banner explains and
 *    links to /welcome.
 * Hidden while `connected`.
 */

import { Link } from "@tanstack/react-router";

import { Icon } from "@/lib/icon";
import { useConnectionState } from "@/state/hooks";

export function ConnectionBanner() {
  const connection = useConnectionState();

  if (connection.status === "connected") {
    return null;
  }

  if (connection.status === "disconnected") {
    return (
      <div
        role="status"
        className="flex h-8 shrink-0 items-center justify-center gap-2 bg-removed-bg px-3 type-micro text-removed"
      >
        <Icon icon="hugeicons:wifi-off-01" className="size-3.5" />
        <span>
          Not connected to a server.{" "}
          <Link to="/welcome" className="underline underline-offset-2">
            Connection details
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-center gap-2 bg-secondary px-3 type-micro text-secondary-foreground"
    >
      <Icon icon="hugeicons:loading-03" className="size-3.5 animate-spin" />
      {connection.status === "connecting"
        ? "Connecting to the server…"
        : "Connection lost — reconnecting…"}
    </div>
  );
}
