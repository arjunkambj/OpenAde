import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { toPublicServerState } from "./publicServerState";
import { ServerSupervisor } from "./ServerSupervisor";

const CONNECTION = {
  url: "ws://127.0.0.1:4100/ws",
  token: "tok",
  serverInstanceId: "srv-1",
};

describe("toPublicServerState", () => {
  it("carries each variant's payload and nulls the others", () => {
    expect(toPublicServerState({ status: "starting" })).toEqual({
      status: "starting",
      connection: null,
      attempt: null,
      reason: null,
    });
    expect(toPublicServerState({ status: "restarting", attempt: 2 })).toEqual({
      status: "restarting",
      connection: null,
      attempt: 2,
      reason: null,
    });
    expect(toPublicServerState({ status: "failed", reason: "exit 1" })).toEqual({
      status: "failed",
      connection: null,
      attempt: null,
      reason: "exit 1",
    });
    expect(toPublicServerState({ status: "ready", connection: CONNECTION })).toEqual({
      status: "ready",
      connection: CONNECTION,
      attempt: null,
      reason: null,
    });
  });

  it("answers the live connection from the supervisor's current state", () => {
    const fd3 = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, fd3],
      kill: () => true,
    });
    const supervisor = new ServerSupervisor({
      spec: () => ({ command: "node", args: [], env: {} }),
      spawn: () => child as unknown as ChildProcess,
      onRepeatedFailure: () => undefined,
    });

    supervisor.start();
    // What a renderer mounting before the handshake would be told.
    expect(toPublicServerState(supervisor.current).connection).toBeNull();

    fd3.emit("data", Buffer.from(`${JSON.stringify(CONNECTION)}\n`));

    // What a renderer mounting after it — with no event left to wait for — asks for.
    expect(toPublicServerState(supervisor.current)).toEqual({
      status: "ready",
      connection: CONNECTION,
      attempt: null,
      reason: null,
    });
    void supervisor.stop();
  });
});
