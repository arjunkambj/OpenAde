/**
 * Owns the OpenAde server process: spawn it, read the bootstrap handshake off
 * fd 3, and restart it on crash with 500ms→10s backoff. After five consecutive
 * failed attempts it pauses and reports instead of spinning forever.
 *
 * Nothing Electron-specific lives here: the spawn spec, the spawn call itself
 * and the repeated-failure hook are injected so the supervisor is unit-testable
 * under plain node. `serverDeps.ts` wires the real ones from the main process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

export type ServerState =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly connection: ServerConnection }
  | { readonly status: "restarting"; readonly attempt: number }
  | { readonly status: "failed"; readonly reason: string };

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 5_000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

/** What to spawn — the bundled server entry, or `tsx watch` in dev. */
export interface SpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export type SpawnServer = (spec: SpawnSpec) => ChildProcess;

export interface ServerSupervisorDeps {
  readonly spec: () => SpawnSpec;
  /** Injectable for tests; defaults to node spawn with fd 3 piped. */
  readonly spawn?: SpawnServer;
  /** Called once the failure streak hits the cap — the crash dialog in prod. */
  readonly onRepeatedFailure: (reason: string) => void;
}

const nodeSpawn: SpawnServer = (spec) =>
  spawn(spec.command, [...spec.args], {
    env: spec.env,
    // stdin/out/err inherited for server logs; fd 3 carries the handshake.
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });

/** Accept only a JSON object carrying the three non-empty connection fields. */
const parseHandshake = (line: string): ServerConnection | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { url, token, serverInstanceId } = parsed as Record<string, unknown>;
    if (typeof url !== "string" || url.length === 0) return null;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof serverInstanceId !== "string" || serverInstanceId.length === 0) return null;
    return { url, token, serverInstanceId };
  } catch {
    return null;
  }
};

export class ServerSupervisor extends EventEmitter {
  private readonly spawnServer: SpawnServer;
  private child: ChildProcess | null = null;
  private state: ServerState = { status: "starting" };
  private failures = 0;
  private backoff = INITIAL_BACKOFF_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: ServerSupervisorDeps) {
    super();
    this.spawnServer = deps.spawn ?? nodeSpawn;
  }

  get current(): ServerState {
    return this.state;
  }

  get connection(): ServerConnection | null {
    return this.state.status === "ready" ? this.state.connection : null;
  }

  private setState(state: ServerState) {
    this.state = state;
    this.emit("state", state);
  }

  start() {
    // Idempotent: a live child or a pending restart already means "started" —
    // a second call here would orphan the first child.
    if (this.child !== null || this.restartTimer !== null) return;
    this.stopped = false;
    this.failures = 0;
    this.backoff = INITIAL_BACKOFF_MS;
    this.spawnOnce();
  }

  /**
   * Signals the child and resolves once it is actually gone — at the latest
   * one SIGKILL after the grace period. The caller on the quit path must await
   * this: the server's own shutdown closes sessions one by one, so signalling
   * and walking away leaves a child holding `state.sqlite` while the next
   * launch starts a second one against it.
   */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child === null) return Promise.resolve();
    return this.killChild(child);
  }

  /**
   * SIGINT first, then SIGKILL once the grace period elapses without an exit.
   *
   * The force-kill timer is deliberately ref'd: an unref'd one never fires in a
   * process whose only remaining work *is* this kill, which is exactly the
   * quit path. `child.once("exit")` clears it, so a child that goes quietly
   * still leaves nothing behind holding the loop open.
   */
  private killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGINT"): Promise<void> {
    return new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill(signal);
    });
  }

  private spawnOnce() {
    const child = this.spawnServer(this.deps.spec());
    this.child = child;
    this.setState({ status: "starting" });

    // The handshake timeout, the spawn error and the exit event can all
    // report the same death — only the first one counts.
    let counted = false;
    const countExit = (reason: string) => {
      if (counted) return;
      counted = true;
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      if (this.child === child) this.child = null;
      this.onExit(reason);
    };

    // A child that spawns but never writes fd 3 (migration stall, locked
    // sqlite) must not sit in "starting" forever — kill it and take the
    // normal failure/backoff path.
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      child.kill("SIGKILL");
      countExit("handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref();

    let handshake = "";
    const settleHandshake = (connection: ServerConnection | null, reason: string) => {
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      child.stdio[3]?.removeListener("data", onHandshake);
      if (connection === null) {
        // A child speaking the wrong protocol is not connectable — recycle it
        // through the same failure/backoff path as a crash. Nothing waits for
        // this one: the restart is already scheduled by `countExit`.
        void this.killChild(child);
        countExit(reason);
        return;
      }
      this.failures = 0;
      this.backoff = INITIAL_BACKOFF_MS;
      this.setState({ status: "ready", connection });
    };
    const onHandshake = (chunk: Buffer) => {
      handshake += chunk.toString("utf8");
      const newline = handshake.indexOf("\n");
      if (newline === -1) {
        // A flood of bytes without a newline is not a handshake either.
        if (handshake.length > MAX_HANDSHAKE_BYTES) {
          settleHandshake(null, `bad handshake: no newline in ${MAX_HANDSHAKE_BYTES} bytes`);
        }
        return;
      }
      const line = handshake.slice(0, newline).trim();
      settleHandshake(parseHandshake(line), `bad handshake: ${line.slice(0, 120)}`);
    };
    child.stdio[3]?.on("data", onHandshake);

    child.once("error", (error) => countExit(error.message));
    child.once("exit", (code, signal) => countExit(`exit ${code ?? signal ?? "?"}`));
  }

  private onExit(reason: string) {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState({ status: "failed", reason });
      this.deps.onRepeatedFailure(reason);
      return;
    }
    this.setState({ status: "restarting", attempt: this.failures });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnOnce();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
}
