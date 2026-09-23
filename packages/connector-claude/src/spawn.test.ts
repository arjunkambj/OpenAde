/**
 * The process group mechanics, against ordinary node children — no harness is
 * involved. Each child prints its pid and its grandchild's, so the test can
 * check the whole group, not only the process it spawned.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isGroupGone, makeProcessGroup } from "./spawn";

/**
 * A child that starts a grandchild in the same process group, reports both
 * pids and its environment, and waits — optionally deaf to SIGTERM.
 */
const program = (ignoreTerm: boolean): string => `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, env: process.env }) + "\\n");
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
setInterval(() => {}, 1000);
`;

interface Report {
  readonly pid: number;
  readonly grandchild: number;
  readonly env: Record<string, string>;
}

const firstLine = (stream: NodeJS.ReadableStream): Promise<Report> =>
  new Promise((resolve) => {
    let buffered = "";
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(buffered.slice(0, end)) as Report);
    });
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const start = (ignoreTerm: boolean) =>
  Effect.gen(function* () {
    const group = makeProcessGroup();
    const child = group.spawn({
      command: process.execPath,
      args: ["-e", program(ignoreTerm)],
      env: { PATH: process.env.PATH, KEPT: "yes", DROPPED: undefined },
    });
    const report = yield* Effect.promise(() => firstLine(child.stdout));
    return { group, child, report };
  });

describe("makeProcessGroup", () => {
  it.live("runs the child with exactly the environment it was handed", () =>
    Effect.gen(function* () {
      const { group, report } = yield* start(false);
      expect(report.env.KEPT).toBe("yes");
      expect("DROPPED" in report.env).toBe(false);
      expect(report.env.HOME).toBeUndefined();
      yield* group.stop;
    }),
  );

  it.live("stops the whole group and proves it gone", () =>
    Effect.gen(function* () {
      const { group, report } = yield* start(false);
      expect(group.latest()?.pid).toBe(report.pid);
      expect(yield* group.isGone).toBe(false);
      expect(isAlive(report.grandchild)).toBe(true);

      yield* group.stop;

      expect(yield* group.isGone).toBe(true);
      expect(isGroupGone(report.pid)).toBe(true);
      expect(isAlive(report.pid)).toBe(false);
      expect(isAlive(report.grandchild)).toBe(false);
    }),
  );

  it.live("escalates to SIGKILL for a child that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const { group, report } = yield* start(true);
      yield* group.stop;
      expect(yield* group.isGone).toBe(true);
      expect(isAlive(report.grandchild)).toBe(false);
    }),
  );

  it.live("signals the group when the SDK kills its view of the child", () =>
    Effect.gen(function* () {
      const { group, child, report } = yield* start(false);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(child.kill("SIGTERM")).toBe(true);
      yield* Effect.promise(() => exited);
      yield* group.stop;
      expect(isAlive(report.grandchild)).toBe(false);
      expect(child.exitCode === null ? child.signalCode : child.exitCode).toBe("SIGTERM");
    }),
  );

  it.live("reports a spawn that never started as gone, and signals nothing", () =>
    Effect.gen(function* () {
      const group = makeProcessGroup();
      const child = group.spawn({ command: "/nonexistent/claude", args: [], env: {} });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => child.once("error", () => resolve())),
      );
      expect(group.children()).toEqual([]);
      expect(child.kill("SIGTERM")).toBe(false);
      expect(yield* group.isGone).toBe(true);
      expect(isGroupGone(-1)).toBe(true);
    }),
  );
});
