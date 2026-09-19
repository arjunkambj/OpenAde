import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerSupervisor, type SpawnSpec } from "./ServerSupervisor";

const SPEC: SpawnSpec = { command: "node", args: ["server.js"], env: {} };

const CONNECTION = {
  url: "http://127.0.0.1:4100",
  token: "tok",
  serverInstanceId: "srv-1",
};

/** Minimal ChildProcess stand-in: an fd-3 emitter, kill recording, and a manual exit. */
class FakeChild extends EventEmitter {
  readonly fd3 = new EventEmitter();
  readonly stdio: ReadonlyArray<unknown> = [null, null, null, this.fd3];
  readonly signals: Array<NodeJS.Signals> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }

  /** Emit a full handshake line on fd 3. */
  handshake(payload: unknown): void {
    this.writeRaw(`${JSON.stringify(payload)}\n`);
  }

  writeRaw(text: string): void {
    this.fd3.emit("data", Buffer.from(text));
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  failToStart(message: string): void {
    this.emit("error", new Error(message));
  }
}

const makeSupervisor = () => {
  const children: Array<FakeChild> = [];
  const failures: Array<string> = [];
  const supervisor = new ServerSupervisor({
    spec: () => SPEC,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    onRepeatedFailure: (reason) => failures.push(reason),
  });
  const last = (): FakeChild => {
    const child = children.at(-1);
    if (child === undefined) throw new Error("no child spawned");
    return child;
  };
  return { supervisor, children, failures, last };
};

describe("ServerSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches ready once fd 3 delivers a well-formed handshake line", () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();
    expect(supervisor.current).toEqual({ status: "starting" });

    // The line may arrive split across chunks.
    last().writeRaw(`{"url":"${CONNECTION.url}",`);
    expect(supervisor.current.status).toBe("starting");
    last().writeRaw(
      `"token":"${CONNECTION.token}","serverInstanceId":"${CONNECTION.serverInstanceId}"}\n`,
    );

    expect(supervisor.current).toEqual({ status: "ready", connection: CONNECTION });
    expect(supervisor.connection).toEqual(CONNECTION);
  });

  it("rejects a handshake missing connection fields and recycles the child", () => {
    const { supervisor, children, last } = makeSupervisor();
    supervisor.start();

    last().handshake({ url: "http://127.0.0.1:4100" });
    expect(last().signals).toEqual(["SIGINT"]);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });

    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
    last().handshake(CONNECTION);
    expect(supervisor.current.status).toBe("ready");
  });

  it("rejects handshake JSON that is not an object", () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();

    last().writeRaw('"just a string"\n');
    expect(last().signals).toEqual(["SIGINT"]);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });
  });

  it("kills a child that never writes fd 3 and takes the backoff path", () => {
    const { supervisor, children, last } = makeSupervisor();
    supervisor.start();

    vi.advanceTimersByTime(15_000);
    expect(last().signals).toEqual(["SIGKILL"]);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });

    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
    last().handshake(CONNECTION);
    expect(supervisor.current.status).toBe("ready");
  });

  it("doubles the restart delay and pauses after five consecutive failures", () => {
    const { supervisor, children, failures, last } = makeSupervisor();
    supervisor.start();

    // 500 → 1000 → 2000 → 4000 between attempts; the fifth death stops it.
    for (const wait of [500, 1000, 2000, 4000]) {
      last().exit(1);
      const spawned = children.length;
      vi.advanceTimersByTime(wait - 1);
      expect(children).toHaveLength(spawned);
      vi.advanceTimersByTime(1);
      expect(children).toHaveLength(spawned + 1);
    }

    last().exit(1);
    expect(supervisor.current).toEqual({ status: "failed", reason: "exit 1" });
    expect(failures).toEqual(["exit 1"]);

    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(5);
  });

  it("counts a spawn error the same as an exit, and only once", () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();

    last().failToStart("spawn ENOENT");
    last().exit(1);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });
  });

  it("resets the strike count once a child handshakes", () => {
    const { supervisor, children, failures, last } = makeSupervisor();
    supervisor.start();

    for (const wait of [500, 1000, 2000, 4000]) {
      last().exit(1);
      vi.advanceTimersByTime(wait);
    }
    expect(children).toHaveLength(5);

    // A successful handshake resets the ladder — the next crash restarts at 500.
    last().handshake(CONNECTION);
    last().exit(1);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });
    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(6);
    expect(failures).toHaveLength(0);
  });

  it("does not orphan a child when start() is called twice", () => {
    const { supervisor, children } = makeSupervisor();
    supervisor.start();
    supervisor.start();
    expect(children).toHaveLength(1);
  });

  it("does not spawn over a pending restart", () => {
    const { supervisor, children, last } = makeSupervisor();
    supervisor.start();
    last().exit(1);
    expect(supervisor.current).toEqual({ status: "restarting", attempt: 1 });

    supervisor.start();
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
  });

  it("can be started again after the five-strike pause", () => {
    const { supervisor, children, last } = makeSupervisor();
    supervisor.start();

    for (const wait of [500, 1000, 2000, 4000]) {
      last().exit(1);
      vi.advanceTimersByTime(wait);
    }
    last().exit(1);
    expect(supervisor.current.status).toBe("failed");

    supervisor.start();
    expect(children).toHaveLength(6);
    expect(supervisor.current.status).toBe("starting");
  });

  it("escalates SIGINT to SIGKILL after the grace period", () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();
    void supervisor.stop();

    expect(last().signals).toEqual(["SIGINT"]);
    vi.advanceTimersByTime(5_000);
    expect(last().signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("does not SIGKILL a child that exits within the grace period", () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();
    void supervisor.stop();
    last().exit(0);

    vi.advanceTimersByTime(60_000);
    expect(last().signals).toEqual(["SIGINT"]);
  });

  /**
   * The quit path awaits this. Resolving on the signal instead would let
   * Electron exit while the server is still closing sessions, and the child
   * would outlive the app holding `state.sqlite`.
   */
  it("stop() resolves only once the child has really exited", async () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();

    let resolved = false;
    const stopped = supervisor.stop().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(last().signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(resolved).toBe(false);

    last().exit(null, "SIGKILL");
    await stopped;
    expect(resolved).toBe(true);
  });

  it("stop() resolves at once when there is no child to wait for", async () => {
    const { supervisor } = makeSupervisor();

    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  it("stop() cancels a pending restart", () => {
    const { supervisor, children, last } = makeSupervisor();
    supervisor.start();
    last().exit(1);
    void supervisor.stop();

    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });
});
