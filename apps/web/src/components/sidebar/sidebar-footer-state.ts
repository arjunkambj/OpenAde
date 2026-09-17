/**
 * What the sidebar footer says about the connection.
 *
 * The footer used to show a hardcoded account name and a Feedback button that
 * did nothing. OpenAde has no accounts — it runs a local server for the person
 * sitting at the machine — so the honest thing in that slot is which server
 * this window is talking to.
 *
 * The banner above the routes already shouts when the socket is down; this is
 * the quiet, always-present version, and it links to /welcome, which is the
 * connection diagnostic.
 */

import type { ConnectionStatus } from "@OpenAde/client-runtime/connection";

export interface FooterConnection {
  readonly label: string;
  /** The server's host and port, or null when no channel resolved one. */
  readonly detail: string | null;
  /** Tailwind classes for the leading dot. */
  readonly dot: string;
}

/** `ws://127.0.0.1:53211/ws` → `127.0.0.1:53211`. Unparseable urls pass through. */
export const serverLabel = (url: string | null | undefined): string | null => {
  if (url === null || url === undefined || url === "") {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const footerConnection = (
  status: ConnectionStatus,
  url: string | null | undefined,
): FooterConnection => {
  const detail = serverLabel(url);
  switch (status) {
    case "connected":
      return { label: "Connected", detail, dot: "bg-added" };
    case "connecting":
      return { label: "Connecting…", detail, dot: "bg-muted-foreground/50" };
    case "reconnecting":
      return { label: "Reconnecting…", detail, dot: "bg-permission" };
    case "incompatible":
      return { label: "Version mismatch", detail, dot: "bg-removed" };
    case "disconnected":
      return { label: "No server", detail, dot: "bg-removed" };
  }
};
