/**
 * Real pseudo-terminals running a real `/bin/sh`, with `HOME` in a temp dir so
 * no rc file of the machine's user can change what the shell prints. Every
 * assertion is on output the shell computed — the terminal echoes what is
 * typed, so matching the typed text would pass without the shell running it.
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { type PtyExit, type PtyProcess, spawnPty } from "./pty";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tempDir = () => realpathSync(mkdtempSync(nodePath.join(tmpdir(), "openade-pty-test-")));

const shellEnv = (home: string): Record<string, string> => ({
  HOME: home,
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TERM: "xterm-256color",
  PS1: "$ ",
});

/** Resolves with everything printed so far once it matches `pattern`. */
const outputMatching = (pty: PtyProcess, pattern: RegExp) => {
  const matched = Deferred.makeUnsafe<string>();
  let seen = "";
  pty.onData((data) => {
    seen += data;
    if (pattern.test(seen)) Deferred.doneUnsafe(matched, Effect.succeed(seen));
  });
  return Deferred.await(matched);
};

const exitOf = (pty: PtyProcess) => {
  const exited = Deferred.makeUnsafe<PtyExit>();
  pty.onExit((exit) => Deferred.doneUnsafe(exited, Effect.succeed(exit)));
  return Deferred.await(exited);
};

describe.skipIf(process.platform === "win32")("spawnPty", () => {
  it.effect("runs a command in the given directory and reports its exit", () =>
    Effect.gen(function* () {
      const cwd = tempDir();
      const pty = yield* spawnPty({
        file: "/bin/sh",
        args: ["-c", 'printf "%s\\n" "$((6*7))"; pwd'],
        cwd,
        env: shellEnv(cwd),
        cols: 80,
        rows: 24,
      });
      const output = outputMatching(pty, new RegExp(`42\\r?\\n${escapeRegExp(cwd)}`));
      const exit = exitOf(pty);
      expect(pty.pid).toBeGreaterThan(0);
      expect(yield* output).toContain("42");
      expect(yield* exit).toEqual({ exitCode: 0, signal: null });
    }),
  );

  it.effect("reports a non-zero exit code", () =>
    Effect.gen(function* () {
      const cwd = tempDir();
      const pty = yield* spawnPty({
        file: "/bin/sh",
        args: ["-c", "exit 3"],
        cwd,
        env: shellEnv(cwd),
        cols: 80,
        rows: 24,
      });
      expect(yield* exitOf(pty)).toEqual({ exitCode: 3, signal: null });
    }),
  );

  it.effect("resizes the terminal an interactive shell sees", () =>
    Effect.gen(function* () {
      const cwd = tempDir();
      const pty = yield* spawnPty({
        file: "/bin/sh",
        args: [],
        cwd,
        env: shellEnv(cwd),
        cols: 80,
        rows: 24,
      });
      const exit = exitOf(pty);
      const size = outputMatching(pty, /30 100/);
      pty.resize(100, 30);
      pty.write("stty size\n");
      yield* size;
      pty.write("exit\n");
      expect((yield* exit).exitCode).toBe(0);
      // Once exited, the handle is inert rather than signalling a reused pid.
      pty.write("echo nobody\n");
      pty.resize(90, 20);
      pty.kill();
    }),
  );

  it.effect("ends the shell on kill", () =>
    Effect.gen(function* () {
      const cwd = tempDir();
      const pty = yield* spawnPty({
        file: "/bin/sh",
        args: [],
        cwd,
        env: shellEnv(cwd),
        cols: 80,
        rows: 24,
      });
      const exit = exitOf(pty);
      const ready = outputMatching(pty, /ready 5/);
      pty.write('echo "ready $((2+3))"\n');
      yield* ready;
      pty.kill("SIGKILL");
      expect((yield* exit).signal).toBe(9);
    }),
  );
});
