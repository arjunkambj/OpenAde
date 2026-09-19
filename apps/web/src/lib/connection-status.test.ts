import { describe, expect, it } from "vitest";

import type { ConnectionState } from "@OpenAde/client-runtime/connection";
import type { DesktopServerState } from "@OpenAde/client-runtime/resolver";

import { connectionNotice } from "./connection-status";
import { AlertTriangle, Close } from "@honeyicons/react";

const socket = (status: ConnectionState["status"]): ConnectionState => ({
  status,
  serverInstanceId: null,
});

const server = (state: DesktopServerState): DesktopServerState => state;

describe("connectionNotice", () => {
  it("says nothing while the socket is up", () => {
    expect(connectionNotice(socket("connected"), null)).toBeNull();
    expect(
      connectionNotice(socket("connected"), server({ status: "restarting", attempt: 2 })),
    ).toBeNull();
    // Even a supervisor that gave up: in dev its `tsx watch` child can burn
    // through its restarts while the renderer is happily connected to a
    // separately started server through the dev endpoint. Painting "reopen
    // OpenAde" over a working app would be a lie.
    expect(
      connectionNotice(socket("connected"), server({ status: "failed", reason: "exited 5 times" })),
    ).toBeNull();
  });

  it("outranks everything with a protocol mismatch", () => {
    // Terminal: the supervisor could be perfectly healthy and a retry still
    // cannot help, so the supervisor's state must not overwrite this.
    const notice = connectionNotice(
      socket("incompatible"),
      server({ status: "ready", connection: null }),
    );
    expect(notice?.tone).toBe("error");
    expect(notice?.message).toContain("Update OpenAde");
  });

  it("names a supervisor that gave up, with its reason, instead of promising a retry", () => {
    const notice = connectionNotice(
      socket("reconnecting"),
      server({ status: "failed", reason: "server exited 3 times" }),
    );
    expect(notice).toEqual({
      tone: "error",
      icon: AlertTriangle,
      message:
        "The server stopped and is not being retried (server exited 3 times). Reopen OpenAde to start it again.",
    });
  });

  it("still tells the user to reopen when the supervisor gave no reason", () => {
    const notice = connectionNotice(socket("reconnecting"), server({ status: "failed" }));
    expect(notice?.message).toBe(
      "The server stopped and is not being retried. Reopen OpenAde to start it again.",
    );
  });

  it("explains a down socket with the restart behind it", () => {
    expect(
      connectionNotice(socket("reconnecting"), server({ status: "restarting", attempt: 2 }))
        ?.message,
    ).toBe("The server stopped — restarting it (attempt 2)…");
    // An older preload that sends no `attempt` still gets the cause, not the
    // symptom.
    expect(
      connectionNotice(socket("reconnecting"), server({ status: "restarting" }))?.message,
    ).toBe("The server stopped — restarting it…");
    expect(connectionNotice(socket("connecting"), server({ status: "starting" }))?.message).toBe(
      "Starting the server…",
    );
  });

  it("falls back to the socket in a plain browser tab", () => {
    expect(connectionNotice(socket("connecting"), null)?.message).toBe("Connecting to the server…");
    expect(connectionNotice(socket("reconnecting"), null)?.message).toBe(
      "Connection lost — reconnecting…",
    );
    expect(connectionNotice(socket("disconnected"), null)).toEqual({
      tone: "error",
      icon: Close,
      message: "Not connected to a server.",
    });
  });

  it("prefers the supervisor's story over a bare disconnected socket", () => {
    // `disconnected` means no channel resolved at boot. In the shell that is
    // usually "the server has not finished starting", and "not connected"
    // is wrong until the supervisor actually gives up.
    expect(connectionNotice(socket("disconnected"), server({ status: "starting" }))?.tone).toBe(
      "pending",
    );
  });
});
