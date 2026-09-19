/**
 * Where the database lives, and who can read it.
 *
 * `state.sqlite` is the whole event log — every prompt, every answer, every
 * tool input, file diffs, the settings document and the permission rules — and
 * under the usual umask `mkdir`/`open` left it at 0755/0644, which any other
 * account on the machine can read. Everything else in the product that holds
 * the same material is already owner-only.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { layer } from "./Sqlite";

const modeOf = (path: string): number => statSync(path).mode & 0o777;

/** A database in a throwaway home, opened exactly as the app opens its own. */
const open = (setUp: (directory: string) => void = () => {}) =>
  Effect.gen(function* () {
    const home = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "openade-sqlite-"));
    const directory = NodePath.join(home, ".openade");
    yield* Effect.sync(() => setUp(directory));
    const filename = NodePath.join(directory, "state.sqlite");
    const built = yield* Layer.build(layer({ filename }));
    // One write, so WAL mode has actually produced its side files: SQLite
    // creates them on the first change, with the mode of the database file.
    yield* Context.get(built, SqlClient.SqlClient)`CREATE TABLE probe (a INTEGER)`;
    return { directory, filename };
  });

describe("the sqlite layer", () => {
  it.effect("creates the config directory and the database owner-only", () =>
    Effect.gen(function* () {
      const { directory, filename } = yield* open();
      expect(modeOf(directory)).toBe(0o700);
      expect(modeOf(filename)).toBe(0o600);
      // WAL mode is on, so the log file is there too — and it holds the most
      // recent events, the ones not yet checkpointed into the database.
      expect(existsSync(`${filename}-wal`)).toBe(true);
      expect(modeOf(`${filename}-wal`)).toBe(0o600);
    }).pipe(Effect.scoped),
  );

  it.effect("tightens a directory and a database an earlier build left open", () =>
    Effect.gen(function* () {
      // Neither `mkdir` nor `open` lowers the mode of something already there,
      // so without the explicit chmod every existing install would have stayed
      // world-readable however carefully the new code creates things.
      const { directory, filename } = yield* open((dir) => {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o755);
        writeFileSync(NodePath.join(dir, "state.sqlite"), "");
        chmodSync(NodePath.join(dir, "state.sqlite"), 0o644);
      });
      expect(modeOf(directory)).toBe(0o700);
      expect(modeOf(filename)).toBe(0o600);
    }).pipe(Effect.scoped),
  );
});
