/**
 * Spawn and transcript tests against real processes and real files — a
 * `node -e` child stands in for `cmd` (it is always here, unlike the CLI),
 * and the tailer runs against a file appended while it is being read.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { buildArgs, envAllowlist, spawnProcess, SpawnError, TOOLS_ENABLED } from "./spawn";
import {
  findTranscriptPath,
  tailTranscript,
  transcriptDirFor,
  transcriptPathFor,
} from "./transcript";

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

  /**
   * `fixtures/cmd/question/` is this argv without the flag: the model is told
   * to use `ask_user_question`, the tool is withheld, and it asks in prose that
   * no card can render. `fixtures/cmd/question-tools/` is the same prompt with
   * it, and the hook receives the real questions.
   */
  it("asks for the withheld tools the user-input card depends on", () => {
    const args = buildArgs({ prompt: "x", toolsEnable: TOOLS_ENABLED });
    expect(TOOLS_ENABLED).toEqual(["ask_user_question"]);
    expect(args[args.indexOf("--tools-enable") + 1]).toBe("ask_user_question");
    // One flag per tool, and none at all when none is asked for.
    expect(buildArgs({ prompt: "x", toolsEnable: ["a", "b"] }).join(" ")).toContain(
      "--tools-enable a --tools-enable b",
    );
    expect(buildArgs({ prompt: "x" })).not.toContain("--tools-enable");
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

  it("keeps the ssh agent and corporate proxy/CA variables", () => {
    const out = envAllowlist({
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      HTTP_PROXY: "http://corp:3128",
      HTTPS_PROXY: "http://corp:3128",
      NO_PROXY: "localhost,.internal",
      SSL_CERT_FILE: "/etc/corp-ca.pem",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(out).toEqual({
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      HTTP_PROXY: "http://corp:3128",
      HTTPS_PROXY: "http://corp:3128",
      NO_PROXY: "localhost,.internal",
      SSL_CERT_FILE: "/etc/corp-ca.pem",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    });
  });

  it("drops server internals and foreign credentials even through extra", () => {
    const out = envAllowlist(
      { HOME: "/home/u", ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2" },
      { OPENADE_SERVER_INTERNAL: "no", ANTHROPIC_AUTH: "no" },
      { OPENADE_HOOK_URL: "http://127.0.0.1/h" },
    );
    expect(out.HOME).toBe("/home/u");
    expect(out.OPENADE_HOOK_URL).toBe("http://127.0.0.1/h");
    expect(Object.keys(out).some((name) => name.includes("ANTHROPIC"))).toBe(false);
    expect(Object.keys(out).some((name) => name.includes("OPENAI"))).toBe(false);
    expect(out.OPENADE_SERVER_INTERNAL).toBeUndefined();
  });

  /**
   * `extraEnv` reaches this from the connectors page through `settings.update`,
   * so an operator-supplied value that wins over the session's own would be an
   * approval gate anyone with the settings page can switch off: a
   * `OPENADE_HOOK_TICKET_FILE` pointing nowhere makes the hook script find no
   * bearer, exit silently, and hand every tool call back to a `--yolo` harness.
   */
  it("never lets extraEnv override the session's control plane", () => {
    const out = envAllowlist(
      { HOME: "/home/u" },
      {
        OPENADE_HOOK_TICKET_FILE: "/nonexistent",
        OPENADE_HOOK_URL: "http://evil.example/hook",
        OPENADE_MCP_TOKEN: "theirs",
        OPENADE_THREAD_ID: "theirs",
      },
      {
        OPENADE_HOOK_URL: "http://127.0.0.1/h",
        OPENADE_HOOK_TICKET_FILE: "/run/ticket",
        OPENADE_MCP_TOKEN: "ours",
        OPENADE_THREAD_ID: "ours",
      },
    );
    expect(out.OPENADE_HOOK_URL).toBe("http://127.0.0.1/h");
    expect(out.OPENADE_HOOK_TICKET_FILE).toBe("/run/ticket");
    expect(out.OPENADE_MCP_TOKEN).toBe("ours");
    expect(out.OPENADE_THREAD_ID).toBe("ours");
  });

  it("drops a reserved name from extraEnv even when the session sets none", () => {
    const out = envAllowlist({}, { OPENADE_HOOK_TICKET_FILE: "/nonexistent" });
    expect(out.OPENADE_HOOK_TICKET_FILE).toBeUndefined();
  });

  it("still passes the operator's own OPENADE_ variables", () => {
    expect(envAllowlist({}, { OPENADE_STUB_MODE: "1" }).OPENADE_STUB_MODE).toBe("1");
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

  it.live(
    "kill escalates to SIGKILL when the child ignores SIGINT",
    () =>
      Effect.gen(function* () {
        const proc = yield* spawnProcess({
          binaryPath: NODE,
          args: [
            "-e",
            'process.on("SIGINT", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
          ],
          cwd: NodeOS.tmpdir(),
          env: envAllowlist(process.env),
        });
        // Wait for the handler to be installed: a SIGINT that lands during
        // node's own startup kills the child before it can ignore anything.
        yield* Stream.runHead(proc.stdout);
        const started = Date.now();
        yield* proc.kill;
        const elapsed = Date.now() - started;
        // The SIGINT was ignored, so the grace period had to run out and the
        // SIGKILL had to land — and `kill` had to come back afterwards, which
        // it did not while the exit code was re-subscribed per await.
        expect(elapsed).toBeGreaterThan(4_000);
        expect(elapsed).toBeLessThan(9_000);
        expect(yield* proc.exitCode).toBe(-1);
      }),
    // A real 5-second grace period, run on the live clock on purpose.
    30_000,
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

  /**
   * The slug is a guess at a private naming scheme, and every real recording
   * disproves it: `manifest.transcriptDirMatchesConnectorSlug` is false in all
   * of them. Those manifests carry both paths, so the test is the recorded
   * difference rather than a second guess at the rule.
   */
  it("finds the session by id when the slug guess is wrong, as it always is", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(
        NodePath.resolve(
          NodeURL.fileURLToPath(import.meta.url),
          "../../../testkit/fixtures/cmd/text/manifest.json",
        ),
        "utf8",
      ),
    ) as {
      readonly turns: ReadonlyArray<{
        readonly sessionId: string;
        readonly transcriptPath: string;
        readonly guessedTranscriptPath: string;
        readonly transcriptDirMatchesConnectorSlug: boolean;
      }>;
    };
    const recorded = manifest.turns[0]!;
    expect(recorded.transcriptDirMatchesConnectorSlug).toBe(false);

    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-slug-test-"));
    try {
      // The real directory name, rebuilt under a temp home: the harness
      // kebab-cases the camel hump (`OpenAde` → `open-ade`) and collapses the
      // repeated dash, so `slugFor` is one directory short of the truth.
      const realDir = NodePath.join(
        home,
        ".commandcode",
        "projects",
        NodePath.basename(NodePath.dirname(recorded.transcriptPath)),
      );
      NodeFS.mkdirSync(realDir, { recursive: true });
      const real = NodePath.join(realDir, `${recorded.sessionId}.jsonl`);
      NodeFS.writeFileSync(real, "{}\n");

      expect(NodePath.basename(NodePath.dirname(recorded.guessedTranscriptPath))).not.toBe(
        NodePath.basename(realDir),
      );
      expect(findTranscriptPath("/whatever/the/cwd/was", recorded.sessionId, home)).toBe(real);
      expect(findTranscriptPath("/whatever/the/cwd/was", "no-such-session", home)).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
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

  it.effect("afterMessageId resumes right after the marker line", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");
      const msg = (id: string, messageId: string): string =>
        JSON.stringify({
          type: "message",
          id,
          message: { role: "assistant", content: [], meta: { messageId } },
        });
      // l1 + l2 were already emitted by a dead runtime; l3 came after.
      NodeFS.writeFileSync(path, `${msg("l1", "a-1")}\n${msg("l2", "a-2")}\n${msg("l3", "a-3")}\n`);

      const tailer = yield* tailTranscript(path, { pollMs: 5, afterMessageId: "a-2" });
      const collected = yield* Stream.runCollect(Stream.take(tailer.lines, 1)).pipe(
        Effect.forkChild,
      );
      expect([...(yield* Fiber.join(collected))]).toEqual([msg("l3", "a-3")]);
      yield* tailer.stop;
    }),
  );

  it.effect("an absent marker falls back to tailing from EOF", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");
      NodeFS.writeFileSync(path, "old-line\n");

      const tailer = yield* tailTranscript(path, { pollMs: 5, afterMessageId: "not-there" });
      const collected = yield* Stream.runCollect(Stream.take(tailer.lines, 1)).pipe(
        Effect.forkChild,
      );
      NodeFS.appendFileSync(path, "new-line\n");
      expect([...(yield* Fiber.join(collected))]).toEqual(["new-line"]);
      yield* tailer.stop;
    }),
  );

  it.effect("stop flushes the unterminated tail instead of dropping it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const path = NodePath.join(dir, "session.jsonl");
      // No trailing newline: "partial-tail" only reaches a consumer through
      // the stop-time flush.
      NodeFS.writeFileSync(path, "a\npartial-tail");

      const tailer = yield* tailTranscript(path, { pollMs: 5, fromStart: true });
      // Receiving "a" proves the reader polled once and holds the tail.
      const first = yield* Stream.runCollect(Stream.take(tailer.lines, 1)).pipe(Effect.forkChild);
      expect([...(yield* Fiber.join(first))]).toEqual(["a"]);

      const rest = yield* Stream.runCollect(tailer.lines).pipe(Effect.forkChild);
      yield* tailer.stop;
      expect([...(yield* Fiber.join(rest))]).toEqual(["partial-tail"]);
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

  /**
   * Every recording shows the transcript appearing seconds into the run, in a
   * directory the slug does not name (`text/` first samples it 3.8s in, at the
   * moment the run ends). A tailer handed a fixed path therefore watches a file
   * that never exists — so it takes a locator and keeps asking.
   */
  it.effect("takes a locator and binds the file the first time it resolves", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const late = NodePath.join(dir, "appears-later.jsonl");
      let visible = false;

      const tailer = yield* tailTranscript(() => (visible ? late : null), { pollMs: 5 });
      const collected = yield* Stream.runCollect(Stream.take(tailer.lines, 2)).pipe(
        Effect.forkChild,
      );

      // Written before the locator admits to it: a file that only appears after
      // the tailer started is read from byte zero, so nothing is skipped.
      NodeFS.writeFileSync(late, "one\ntwo\n");
      visible = true;

      expect([...(yield* Fiber.join(collected))]).toEqual(["one", "two"]);
      yield* tailer.stop;
    }),
  );
});
