/**
 * What the connection banner says, as data.
 *
 * Two sources, and they answer different questions. `ConnectionState` is the
 * websocket: is this renderer talking to a server right now. The desktop
 * shell's `DesktopServerState` is the process behind it: is a server being
 * started, restarted, or has the supervisor given up. A renderer that only
 * reads the socket says "reconnecting…" forever after the supervisor has
 * stopped trying, which is the one case where the user has to do something.
 *
 * The rules, in the order they are applied:
 *
 *  1. `incompatible` is terminal and outranks everything — retrying cannot fix
 *     a protocol mismatch, and the supervisor's own state is irrelevant to it.
 *  2. A live socket says nothing at all. Whatever the supervisor got up to, it
 *     is not the user's problem while the app is talking to a server — in dev
 *     the shell's own child can exhaust its restarts against a server the
 *     renderer never used.
 *  3. A supervisor that has given up is the next most important thing to say,
 *     even while the socket is still politely "reconnecting".
 *  4. A server that is starting or restarting explains a socket that is down,
 *     so the banner names the cause rather than the symptom.
 *  5. Otherwise the socket speaks for itself.
 *
 * `null` means "say nothing": the socket is up, so whatever the supervisor
 * did, it landed.
 *
 * Kept pure and free of React so the wording is under test.
 */

import type { ConnectionState } from "@OpenAde/client-runtime/connection";
import type { DesktopServerState } from "@OpenAde/client-runtime/resolver";
import { type HoneyIcon, AlertTriangle, Close, Spinner } from "@honeyicons/react";

export interface ConnectionNotice {
  /** `pending` is a quiet strip with a spinner; `error` is the loud one. */
  readonly tone: "pending" | "error";
  readonly icon: HoneyIcon;
  readonly message: string;
}

const pending = (message: string): ConnectionNotice => ({
  tone: "pending",
  icon: Spinner,
  message,
});

/**
 * The retry hint a `failed` supervisor owes the user: it is not coming back on
 * its own, and the reason it gave is the only clue why.
 */
const gaveUp = (reason: string | null | undefined): ConnectionNotice => ({
  tone: "error",
  icon: AlertTriangle,
  message:
    reason === null || reason === undefined || reason === ""
      ? "The server stopped and is not being retried. Reopen OpenAde to start it again."
      : `The server stopped and is not being retried (${reason}). Reopen OpenAde to start it again.`,
});

export const connectionNotice = (
  connection: ConnectionState,
  server: DesktopServerState | null,
): ConnectionNotice | null => {
  if (connection.status === "incompatible") {
    return {
      tone: "error",
      icon: AlertTriangle,
      message: "The server speaks a different protocol version. Update OpenAde to continue.",
    };
  }
  if (connection.status === "connected") {
    return null;
  }
  if (server !== null && server.status === "failed") {
    return gaveUp(server.reason);
  }
  if (server !== null && server.status === "restarting") {
    const attempt = server.attempt ?? null;
    return pending(
      attempt === null
        ? "The server stopped — restarting it…"
        : `The server stopped — restarting it (attempt ${attempt})…`,
    );
  }
  if (server !== null && server.status === "starting") {
    return pending("Starting the server…");
  }
  if (connection.status === "disconnected") {
    return {
      tone: "error",
      icon: Close,
      message: "Not connected to a server.",
    };
  }
  return pending(
    connection.status === "connecting"
      ? "Connecting to the server…"
      : "Connection lost — reconnecting…",
  );
};
