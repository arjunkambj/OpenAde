/**
 * The last step of killing a terminal: SIGKILL for a shell that ignored
 * SIGHUP, and for every job it started.
 *
 * A terminal's shell is interactive, so job control is on and each job runs
 * in a process group of its own. The groups share the shell's session, not
 * its group, so SIGKILL to the shell's group alone ends the shell and leaves
 * its jobs running. The jobs are found as the shell's descendants in the
 * process table, which has to be read while the shell is still alive: once it
 * dies they are re-parented to init and nothing links them to it any more.
 * The walk goes by parent pid because `ps` has no portable way to list a
 * session — macOS prints no session id at all.
 */
import { execFile } from "node:child_process";
import * as Effect from "effect/Effect";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/** A `ps` that hangs must not hang the kill with it. */
const PS_TIMEOUT_MS = 2_000;

/** Parses `ps -A -o pid=,ppid=,pgid=`; a line that is not three numbers is skipped. */
export const parseProcessTable = (text: string): ReadonlyArray<ProcessRow> => {
  const rows: Array<ProcessRow> = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length !== 3 || !fields.every((field) => Number.isInteger(field) && field >= 0)) {
      continue;
    }
    const [pid, ppid, pgid] = fields as [number, number, number];
    if (pid > 0) rows.push({ pid, ppid, pgid });
  }
  return rows;
};

export interface TreeTargets {
  /** The root and every descendant. */
  readonly pids: ReadonlyArray<number>;
  /** The root's group and every descendant's, init's never. */
  readonly groups: ReadonlyArray<number>;
}

/** The processes under `root` and the groups they are in, read from one snapshot of the table. */
export const treeTargets = (rows: ReadonlyArray<ProcessRow>, root: number): TreeTargets => {
  const children = new Map<number, Array<ProcessRow>>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row]);
    else siblings.push(row);
  }
  const pids = new Set<number>([root]);
  const groups = new Set<number>([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (pids.has(child.pid)) continue;
      pids.add(child.pid);
      if (child.pgid > 1) groups.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return { pids: [...pids], groups: [...groups] };
};

/**
 * The process table, or nothing when `ps` is missing, fails or hangs — the
 * kill then still reaches the shell and its own group.
 */
const readProcessTable: Effect.Effect<ReadonlyArray<ProcessRow>> = Effect.callback((resume) => {
  const child = execFile(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid="],
    {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    },
    (_error, stdout) => resume(Effect.succeed(parseProcessTable(String(stdout)))),
  );
  return Effect.sync(() => {
    child.kill("SIGKILL");
  });
});

const sigkill = (target: number) => {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
};

/**
 * SIGKILLs `root`, every process under it and every group they are in. The
 * table is read first and the signals all go out in one synchronous step
 * after it, so no process is re-parented away between being found and being
 * killed. `running` is asked once the table is in: a root that exited while
 * `ps` ran is left alone, since its pid and group id may no longer be its own,
 * but the jobs it left behind are still killed.
 */
export const killTree = (root: number, running: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rows = yield* readProcessTable;
    const rootToo = running();
    const { pids, groups } = treeTargets(rows, root);
    for (const group of groups) if (rootToo || group !== root) sigkill(-group);
    for (const pid of pids) if (rootToo || pid !== root) sigkill(pid);
  });
