/**
 * Owns the OpenAde server process: spawn it (the bundled `main.cjs` under
 * `ELECTRON_RUN_AS_NODE`, or `tsx watch` in dev), read the bootstrap handshake
 * off fd 3, and restart it on crash with 500ms→10s backoff. After five
 * consecutive failed attempts it pauses and shows a dialog instead of
 * spinning forever.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { app, dialog } from "electron";

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

// Bundled to cjs — `__dirname` is real at runtime.
declare const __dirname: string;
const here = dirname(__dirname);

export class ServerSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: ServerState = { status: "starting" };
  private failures = 0;
  private backoff = INITIAL_BACKOFF_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** The bundled server entry, or the tsx entry in dev. */
  private spawnSpec(): { command: string; args: Array<string>; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENADE_DEV: app.isPackaged ? "" : "1",
    };
    if (app.isPackaged) {
      // The bundle is asar-unpacked so the child can spawn it directly.
      const entry = join(__dirname, "..", "server", "main.cjs").replace(
        "app.asar",
        "app.asar.unpacked",
      );
      return {
        command: process.execPath,
        args: [entry],
        env,
      };
    }
    const require = createRequire(join(here, "../../server/package.json"));
    const tsx = require.resolve("tsx/cli");
    return {
      command: process.execPath,
      args: [tsx, "watch", join(here, "../../server/src/main.ts")],
      env,
    };
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
    this.stopped = false;
    this.spawnOnce();
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill("SIGINT");
    this.child = null;
  }

  private spawnOnce() {
    const { command, args, env } = this.spawnSpec();
    const child = spawn(command, args, {
      env,
      // stdin/out/err inherited for server logs; fd 3 carries the handshake.
      stdio: ["ignore", "inherit", "inherit", "pipe"],
    });
    this.child = child;

    let handshake = "";
    const onHandshake = (chunk: Buffer) => {
      handshake += chunk.toString("utf8");
      const newline = handshake.indexOf("\n");
      if (newline === -1) return;
      const line = handshake.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as ServerConnection;
        this.failures = 0;
        this.backoff = INITIAL_BACKOFF_MS;
        this.setState({ status: "ready", connection: parsed });
      } catch {
        this.setState({ status: "failed", reason: `bad handshake: ${line.slice(0, 120)}` });
      }
      child.stdio[3]?.removeListener("data", onHandshake);
    };
    child.stdio[3]?.on("data", onHandshake);

    child.once("error", (error) => this.onExit(error.message));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.onExit(`exit ${code ?? signal ?? "?"}`);
    });
  }

  private onExit(reason: string) {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState({ status: "failed", reason });
      void dialog.showMessageBox({
        type: "error",
        title: "OpenAde server stopped",
        message: "The OpenAde server crashed repeatedly and will not restart.",
        detail: reason,
        buttons: ["OK"],
      });
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
