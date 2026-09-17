/**
 * Spawn and transcript tests against real processes and real files — a
 * `node -e` child stands in for `cmd` (it is always here, unlike the CLI),
 * and the tailer runs against a file appended while it is being read.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { buildArgs, envAllowlist, spawnProcess, SpawnError } from "./spawn";
import { tailTranscript, transcriptDirFor, transcriptPathFor } from "./transcript";

const NODE = process.execPath;

const tempDir = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-proc-test-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

// ── argv ───────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("builds the spec 5.1 headless argv in a stable order", () => {
    expect(buildArgs({ prompt: "do it" })).toEqual([
      "-p",
      "do it",
      "--output-format",
      "json",
      "--verbose",
      "-t",
      "--skip-onboarding",
      "--no-auto-update",
    ]);
  });

  it("appends the optional flags", () => {
    expect(
      buildArgs({
        prompt: "go",
        sessionId: "sess-9",
        model: "stealth/ox-alpha",
        effort: "high",
        yolo: true,
        maxTurns: 4,
        addDir: ["../shared", "/tmp/extra"],
      }),
    ).toEqual([
      "-p",
      "go",
      "--output-format",
      "json",
      "--verbose",
      "-t",
      "--skip-onboarding",
      "--no-auto-update",
      "--session",
      "sess-9",
      "--model",
      "stealth/ox-alpha",
      "--effort",
      "high",
      "--yolo",
      "--max-turns",
      "4",
      "--add-dir",
      "../shared",
      "--add-dir",
      "/tmp/extra",
    ]);
  });

  it("uses --no-session or --permission-mode instead of --session", () => {
    expect(buildArgs({ prompt: "x", noSession: true })).toContain("--no-session");
    expect(buildArgs({ prompt: "x", noSession: true })).not.toContain("--session");
    const plan = buildArgs({ prompt: "x", permissionMode: "plan" });
    expect(plan).toContain("--permission-mode");
    expect(plan[plan.indexOf("--permission-mode") + 1]).toBe("plan");
  });
});

// ── environment allowlist ──────────────────────────────────────

describe("envAllowlist", () => {
  it("keeps the base set, LC_* locales, Command Code and OPENADE_* variables", () => {
    const out = envAllowlist({
      HOME: "/home/u",
      PATH: "/bin",
      LC_ALL: "en_US.UTF-8",
      LC_TIME: "en_US",
      COMMAND_CODE_API_KEY: "ck-1",
      OPENADE_THREAD_ID: "t1",
      AWS_SECRET_ACCESS_KEY: "nope",
      npm_config_cache: "nope",
    });
    expect(out).toEqual({
      HOME: "/home/u",
      PATH: "/bin",
      LC_ALL: "en_US.UTF-8",
      LC_TIME: "en_US",
      COMMAND_CODE_API_KEY: "ck-1",
      OPENADE_THREAD_ID: "t1",
    });
  });

  it("drops control-plane and foreign credentials even through extra", () => {
    const out = envAllowlist(
      { HOME: "/home/u", ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2" },
      {
        OPENADE_HOOK_URL: "http://127.0.0.1/h",
        OPENADE_SERVER_INTERNAL: "no",
        ANTHROPIC_AUTH: "no",
        EXTRA_SAFE: "no",
      },
    );
    expect(out.HOME).toBe("/home/u");
    expect(out.OPENADE_HOOK_URL).toBe("http://127.0.0.1/h");
    expect(Object.keys(out).some((name) => name.includes("ANTHROPIC"))).toBe(false);
    expect(Object.keys(out).some((name) => name.includes("OPENAI"))).toBe(false);
    expect(out.OPENADE_SERVER_INTERNAL).toBeUndefined();
    // extraEnv entries that are not allowlisted do not pass either.
    expect(out.EXTRA_SAFE).toBeUndefined();
  });
});

// ── spawning a real child ──────────────────────────────────────

describe("spawnProcess on a node -e child", () => {
  it.effect("streams stdout and stderr and resolves the exit code", () =>
    Effect.gen(function* () {
      const proc = yield* spawnProcess({
        binaryPath: NODE,
        args: ["-e", 'process.stdout.write("out-1\\nout-2\\n"); process.stderr.write("err-1\\n");'],
        cwd: NodeOS.tmpdir(),
        env: envAllowlist(process.env),
      });
      const [stdout, stderr, code] = yield* Effect.all([
        Stream.runCollect(proc.stdout),
        Stream.runCollect(proc.stderr),
        proc.exitCode,
      ]);
      expect(stdout.join("")).toBe("out-1\nout-2\n");
      expect(stderr.join("")).toBe("err-1\n");
      expect(code).toBe(0);
    }),
  );

  it.effect("fails with SpawnError for a binary that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* spawnProcess({
        binaryPath: "/nonexistent/cmd-binary-xyz",
        args: [],
        cwd: NodeOS.tmpdir(),
        env: {},
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SpawnError);
    }),
  );

  it.effect("kill stops a sleeping process and settles the exit code", () =>
    Effect.gen(function* () {
      const proc = yield* spawnProcess({
        binaryPath: NODE,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: NodeOS.tmpdir(),
        env: envAllowlist(process.env),
      });
      const exited = yield* Effect.forkChild(proc.exitCode);
      yield* proc.kill;
      // SIGINT'd children report no exit code — -1 is the "died on a signal".
      expect(yield* Fiber.join(exited)).toBe(-1);
      // And the process really is gone: signalling it now does nothing.
      yield* proc.signal("SIGKILL");
    }),
  );

  it.effect("interrupt via signal resolves the process", () =>
    Effect.gen(function* () {
      const proc = yield* spawnProcess({
        binaryPath: NODE,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: NodeOS.tmpdir(),
        env: envAllowlist(process.env),
      });
      const exited = yield* Effect.forkChild(proc.exitCode);
      yield* proc.signal("SIGINT");
      yield* Fiber.join(exited);
      yield* proc.kill;
    }),
  );

  it.effect("closing the scope kills a still-running child", () =>
    Effect.gen(function* () {
      let pid = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const proc = yield* spawnProcess({
            binaryPath: NODE,
            args: ["-e", "setInterval(() => {}, 1000)"],
            cwd: NodeOS.tmpdir(),
            env: envAllowlist(process.env),
          });
          pid = proc.pid;
        }),
      );
      // The finalizer's SIGINT already landed; a second signal is a no-op.
      const alive = yield* Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(alive).toBe(false);
    }),
  );
});

// ── transcript paths ───────────────────────────────────────────

describe("transcript paths", () => {
  it("slugs the cwd the way the harness does", () => {
    expect(transcriptDirFor("/Volumes/Main/Code", "/home/test")).toBe(
      "/home/test/.commandcode/projects/volumes-main-code",
    );
    expect(transcriptPathFor("/repo", "abc-123", "/home/test")).toBe(
      "/home/test/.commandcode/projects/repo/abc-123.jsonl",
    );
  });
});

// ── the byte-offset tailer ─────────────────────────────────────

describe("tailTranscript", () => {
  it.effect("emits lines appended after the tailer starts, complete lines only", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");

      const tailer = yield* tailTranscript(path, { pollMs: 5 });
      const collected = yield* Stream.runCollect(Stream.take(tailer.lines, 3)).pipe(
        Effect.forkChild,
      );

      // The file does not exist yet — the tailer waits for it to appear.
      NodeFS.writeFileSync(path, "first\npar");
      NodeFS.appendFileSync(path, "tial\nsecond\nthird\n");

      const lines = yield* Fiber.join(collected);
      expect([...lines]).toEqual(["first", "partial", "second"]);
      yield* tailer.stop;
    }),
  );

  it.effect("skips existing content by default and replays it with fromStart", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");
      NodeFS.writeFileSync(path, "old-1\nold-2\n");

      const fresh = yield* tailTranscript(path, { pollMs: 5 });
      const freshLines = yield* Stream.runCollect(Stream.take(fresh.lines, 1)).pipe(
        Effect.forkChild,
      );
      NodeFS.appendFileSync(path, "new-1\n");
      expect([...(yield* Fiber.join(freshLines))]).toEqual(["new-1"]);
      yield* fresh.stop;

      const replay = yield* tailTranscript(path, { pollMs: 5, fromStart: true });
      const all = yield* Stream.runCollect(Stream.take(replay.lines, 3)).pipe(Effect.forkChild);
      expect([...(yield* Fiber.join(all))]).toEqual(["old-1", "old-2", "new-1"]);
      yield* replay.stop;
    }),
  );

  it.effect("stop ends the stream and closing the scope stops the reader", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");
      NodeFS.writeFileSync(path, "a\n");

      // Lines already delivered drain; a stop races only work not yet read.
      const tailer = yield* tailTranscript(path, { pollMs: 5, fromStart: true });
      const first = yield* Stream.runCollect(Stream.take(tailer.lines, 1)).pipe(Effect.forkChild);
      expect([...(yield* Fiber.join(first))]).toEqual(["a"]);
      yield* tailer.stop;
      expect([...(yield* Stream.runCollect(tailer.lines))]).toEqual([]);

      // Closing the tailer's scope stops the reader: a consumer parked on the
      // stream completes instead of hanging.
      const scope = yield* Scope.make();
      const inner = yield* tailTranscript(path, { pollMs: 5, fromStart: true }).pipe(
        Scope.provide(scope),
      );
      const head = yield* Stream.runCollect(Stream.take(inner.lines, 1)).pipe(Effect.forkChild);
      expect([...(yield* Fiber.join(head))]).toEqual(["a"]);
      const drained = yield* Stream.runCollect(inner.lines).pipe(Effect.forkChild);
      yield* Scope.close(scope, Exit.succeed(undefined));
      expect([...(yield* Fiber.join(drained))]).toEqual([]);
    }),
  );
});
