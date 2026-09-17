/**
 * The dev handshake file carries the bearer token for the socket that accepts
 * `orchestration.dispatch`, so its mode is part of the contract: only the
 * account running the server may read it.
 *
 * `writeHandshake` itself is not exercised here — it writes to fd 3, which is
 * a live pipe inside a test worker.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { writeDevConnectionFile } from "./bootstrap";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("writeDevConnectionFile", () => {
  it.effect("keeps the token readable only by its owner", () =>
    Effect.sync(() => {
      const home = mkdtempSync(join(tmpdir(), "openade-handshake-"));
      const path = join(home, "dev", "connection.json");
      const line = JSON.stringify({
        url: "ws://127.0.0.1:1234/ws",
        token: "secret",
        serverInstanceId: "boot-1",
      });

      writeDevConnectionFile(line, path);
      expect(readFileSync(path, "utf8")).toBe(`${line}\n`);
      expect(mode(path)).toBe(0o600);
      expect(mode(dirname(path))).toBe(0o700);

      // A file an older build left world-readable must be tightened, not left
      // as it is: writeFileSync's mode only applies when it creates the file.
      writeFileSync(path, "stale", { mode: 0o644 });
      writeDevConnectionFile(line, path);
      expect(mode(path)).toBe(0o600);
    }),
  );
});
