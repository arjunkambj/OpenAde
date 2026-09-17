/**
 * How the desktop main process (or a dev shell) learns where the server is.
 * fd 3 is the Electron spawn pipe; without it the same JSON goes to stdout as
 * one line. In dev the file `~/.openade/dev/connection.json` is the Vite
 * plugin's answer to `GET /__openade/connection`.
 */

import { chmodSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { devConnectionPath } from "@OpenAde/shared/paths";
import * as Effect from "effect/Effect";

export interface ServerHandshake {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

/** `<config dir>/dev/connection.json`, so `OPENADE_HOME` moves it with the rest. */
export const DEV_CONNECTION_PATH = devConnectionPath();

/**
 * Writes the dev handshake file. It holds the bearer token for a socket that
 * accepts `orchestration.dispatch`, so any local account that can read it can
 * drive the agent: the directory and the file are owner-only. `writeFileSync`
 * does not lower an existing file's mode, hence the explicit `chmod` — a file
 * an earlier build left world-readable is tightened on the next boot.
 *
 * `path` is a parameter so a test can point it somewhere disposable.
 */
export const writeDevConnectionFile = (line: string, path = DEV_CONNECTION_PATH): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${line}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/**
 * Emits the handshake. fd 3 exists only when the desktop spawned us with an
 * extra pipe, so `writeSync` throwing is the normal terminal path. Returns
 * which channel delivered it.
 */
export const writeHandshake = (
  handshake: ServerHandshake,
  options: { readonly dev: boolean },
): Effect.Effect<"fd3" | "stdout"> =>
  Effect.sync(() => {
    const line = JSON.stringify(handshake);
    let channel: "fd3" | "stdout" = "stdout";
    try {
      writeSync(3, `${line}\n`);
      channel = "fd3";
    } catch {
      process.stdout.write(`${line}\n`);
    }
    if (options.dev) {
      writeDevConnectionFile(line);
    }
    return channel;
  });
