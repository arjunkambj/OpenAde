/**
 * How the desktop main process (or a dev shell) learns where the server is.
 * fd 3 is the Electron spawn pipe; without it the same JSON goes to stdout as
 * one line. In dev the file `~/.openade/dev/connection.json` is the Vite
 * plugin's answer to `GET /__openade/connection`.
 */

import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

export interface ServerHandshake {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

export const DEV_CONNECTION_PATH = join(homedir(), ".openade", "dev", "connection.json");

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
      mkdirSync(join(homedir(), ".openade", "dev"), { recursive: true });
      writeFileSync(DEV_CONNECTION_PATH, `${line}\n`);
    }
    return channel;
  });
