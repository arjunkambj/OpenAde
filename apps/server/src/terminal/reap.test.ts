/**
 * The tree walk over hand-written process tables, then the whole kill against
 * a real `/bin/sh` that ignores SIGHUP and has a job running in a group of its
 * own — the case SIGKILL to the shell's group alone used to leave running.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeTerminalId, makeThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { parseProcessTable, treeTargets } from "./reap";
import { makeSession } from "./session";

describe("parseProcessTable", () => {
  it("reads pid, parent and group, and skips anything else", () => {
    const table = "    1     0     1\n  412     1   412\nnoise\n  413   412   413 extra\n\n";
    expect(parseProcessTable(table)).toEqual([
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 412, ppid: 1, pgid: 412 },
    ]);
  });
});

describe("treeTargets", () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    // The shell, a job in a group of its own, that job's child, and a
    // pipeline sharing one group.
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 101, ppid: 100, pgid: 101 },
    { pid: 102, ppid: 101, pgid: 101 },
    { pid: 103, ppid: 100, pgid: 103 },
    { pid: 104, ppid: 100, pgid: 103 },
    // Someone else's.
    { pid: 200, ppid: 1, pgid: 200 },
    { pid: 201, ppid: 200, pgid: 200 },
  ];

  it("takes every descendant and every group they are in", () => {
    const targets = treeTargets(rows, 100);
    expect([...targets.pids].sort()).toEqual([100, 101, 102, 103, 104]);
    expect([...targets.groups].sort()).toEqual([100, 101, 103]);
  });

  it("still names the root when the table does not list it", () => {
    expect(treeTargets([], 100)).toEqual({ pids: [100], groups: [100] });
  });

  it("never names init's group", () => {
    const daemon = [{ pid: 300, ppid: 100, pgid: 1 }];
    expect(treeTargets(daemon, 100)).toEqual({ pids: [100, 300], groups: [100] });
  });
});

const groupOf = (pid: number) =>
  Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());

/**
 * Reads `fifo` to its end. `opened` resolves once a writer holds it open too,
 * and `gone` once the last writer has exited, killed or not.
 */
const readToEnd = (fifo: string) => {
  const stream = createReadStream(fifo);
  stream.on("data", () => {});
  return {
    opened: new Promise<void>((resolve, reject) => {
      stream.on("open", () => resolve());
      stream.on("error", reject);
    }),
    gone: new Promise<void>((resolve) => stream.on("end", () => resolve())),
  };
};

describe.skipIf(process.platform === "win32")("killing a shell that ignores SIGHUP", () => {
  it.live(
    "reaches the jobs in groups of their own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(nodePath.join(tmpdir(), "openade-reap-test-"))),
            (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
          );
          const session = yield* makeSession({
            threadId: makeThreadId(),
            terminalId: makeTerminalId(),
            title: "Terminal",
            cwd: home,
            cols: 80,
            rows: 24,
            shell: { file: "/bin/sh", args: [] },
            env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " },
          }).pipe(Effect.orDie);
          const output = yield* makeStreamCollector(
            Stream.fromPubSub(session.hub).pipe(
              Stream.mapAccum(
                () => "",
                (text, item): readonly [string, ReadonlyArray<string>] => {
                  const next = item.kind === "output" ? text + item.data : text;
                  return [next, [next]];
                },
              ),
            ),
          );
          // The job's stdout is a fifo the shell makes, so its exit is
          // observable without polling: the read end sees EOF once the job
          // is gone. The echo of the typed line holds `$!`, never digits, so
          // only the shell's own output matches; `$!` ends the line, since
          // before a quote bash's history expansion would take the `!`.
          session.write("mkfifo job; trap '' HUP; sleep 300 > job & echo job=$!\n");
          const seen = yield* output
            .awaitItem((text) => /job=\d+\r?\n/.test(text))
            .pipe(Effect.orDie);
          const job = Number(/job=(\d+)/.exec(seen)![1]);
          const reader = readToEnd(nodePath.join(home, "job"));
          let gone = false;
          const jobGone = reader.gone.then(() => {
            gone = true;
          });
          yield* Effect.promise(() => reader.opened);
          // A job the kill missed must not outlive the test. Only while it
          // is known to be alive: once gone, its pid may be another's.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (!gone) {
                process.kill(job, "SIGKILL");
              }
            }),
          );
          // The case under test: job control put the job in a group of its own.
          expect(groupOf(job)).not.toBe(groupOf(session.summary().pid));

          yield* session.kill;
          expect(session.view().exit?.signal).not.toBeNull();
          yield* Effect.promise(() => jobGone);
        }),
      ),
    15_000,
  );
});
