/**
 * The `sdk-stream` replayer, spawned as a real process.
 *
 * The recording it replays is made first, in a temp directory, by the real tee
 * in front of an ordinary node program (`stdioCounterpart.ts`) — never a
 * harness stand-in, and never under `fixtures/`. What is under test is the
 * transport mechanics: gating on stdin, request-id rewriting, loud divergence,
 * and which recorded invocation a launch plays.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPLAY_DIVERGED, sdkStreamReplayer } from "./replaySdkStream";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "./sdkStreamRecording";
import { converse, writeCounterpart } from "./stdioCounterpart";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sdk-stream-replay-"));
const FIXTURES = NodePath.join(ROOT, "fixtures");
const STREAM_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json"];
/** Where the replays run: a different scratch root from the recording's. */
const REPLAY_REPO = NodePath.join(ROOT, "elsewhere", "repo");

const typed =
  (type: string) =>
  (line: unknown): boolean =>
    (line as { type?: string }).type === type;

type Run = ReturnType<typeof converse>;

/** One full exchange: initialize, a user message, and an answer to the question it raises. */
const exchange = async (run: Run, requestId: string, behavior: string): Promise<unknown> => {
  await run.awaitLine(typed("ready"));
  run.send({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
  const initialized = await run.awaitLine(typed("control_response"));
  run.send({ type: "user", message: { role: "user", content: "hello" } });
  const asked = (await run.awaitLine(typed("control_request"))) as { request_id: string };
  run.send({
    type: "control_response",
    response: { subtype: "success", request_id: asked.request_id, response: { behavior } },
  });
  return initialized;
};

const answer = (requestId: string, behavior: string): unknown => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response: { behavior } },
});

/** Two user messages sent back to back, so both questions they raise are open together. */
const askTwice = async (run: Run): Promise<void> => {
  await run.awaitLine(typed("ready"));
  run.send({ type: "user", message: { role: "user", content: "one" } });
  run.send({ type: "user", message: { role: "user", content: "two" } });
  await run.awaitLine(typed("control_request"));
  await run.awaitLine(typed("control_request"));
};

beforeAll(async () => {
  const repo = NodePath.join(ROOT, "scratch", "repo");
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeFS.mkdirSync(REPLAY_REPO, { recursive: true });
  const rawDir = NodePath.join(ROOT, "raw");
  const launcher = makeTeeLauncher({
    realBinary: writeCounterpart(NodePath.join(ROOT, "bin")),
    rawDir,
  });

  // Invocation 1: a version probe. 2: a run answered "allow". 3: one answered "deny".
  expect((await converse(launcher, ["--version"], { cwd: repo }).exited).code).toBe(0);
  for (const [id, behavior] of [
    ["recorded-1", "allow"],
    ["recorded-2", "deny"],
  ] as const) {
    const run = converse(launcher, STREAM_ARGS, { cwd: repo });
    await exchange(run, id, behavior);
    await run.awaitLine(typed("result"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  }

  // A run with two questions open at once, answered in the order they were asked.
  const twoOpenRaw = NodePath.join(ROOT, "raw-two-open");
  const twoOpen = converse(
    makeTeeLauncher({
      realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
      rawDir: twoOpenRaw,
    }),
    STREAM_ARGS,
    { cwd: repo },
  );
  await askTwice(twoOpen);
  for (const [id, behavior] of [
    ["asked-1", "allow"],
    ["asked-2", "deny"],
  ]) {
    twoOpen.send(answer(id!, behavior!));
  }
  await twoOpen.awaitLine(
    (line) => typed("result")(line) && (line as { request_id?: string }).request_id === "asked-2",
  );
  twoOpen.child.stdin.end();
  expect((await twoOpen.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "two-open",
    rawDir: twoOpenRaw,
    description: "an ordinary node program with two requests open at once",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["one", "two"],
    fixturesRoot: FIXTURES,
  });

  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "exchange",
    rawDir,
    description: "an ordinary node program, for the replayer's own test",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["hello", "hello"],
    fixturesRoot: FIXTURES,
  });
});

afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const replayer = sdkStreamReplayer("sample", FIXTURES);
let configs = 0;
/** A fresh launcher with a fresh invocation counter. */
const freshBinary = (pidDir?: string): string =>
  replayer.config("exchange", {
    tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    ...(pidDir === undefined ? {} : { pidDir }),
  }).binaryPath;

describe("sdkStreamReplayer", () => {
  it("is the sdk-stream replayer for the kind it is given", () => {
    expect(replayer.kind).toBe("sample");
    expect(replayer.transport).toBe("sdk-stream");
  });

  it("writes nothing past a frame the live side has not sent yet", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    const ready = (await run.awaitLine(typed("ready"))) as { cwd: string };
    // `<SCRATCH>` is put back from this run's own directories.
    expect(ready.cwd).toBe(NodeFS.realpathSync(REPLAY_REPO));
    run.child.stdin.end();

    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("stdin closed while the recording expects");
    // The recorded initialize answer was never written: the replay was
    // blocked on the request it answers.
    expect(run.seen()).toEqual([ready]);
  });

  it("rewrites the SDK's own request ids to the live ones", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    const initialized = await exchange(run, "live-42", "allow");
    expect(initialized).toMatchObject({ response: { request_id: "live-42" } });
    expect(await run.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  });

  it("exits 97 when the live answer differs from the recorded one", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(run, "live-1", "deny");
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different behavior");
    expect(exit.stderr).toContain('"behavior":"allow"');
    expect(exit.stderr).toContain('"behavior":"deny"');
  });

  it("exits 97 when the live side sends a different kind of line", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await run.awaitLine(typed("ready"));
    run.send({ type: "user", message: { role: "user", content: "too early" } });
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different type");
  });

  it("plays the next recorded invocation of each argv class, counted across launches", async () => {
    const pidDir = NodePath.join(ROOT, "pids");
    const binary = freshBinary(pidDir);

    const version = converse(binary, ["--version"], { cwd: REPLAY_REPO });
    expect(await version.awaitLine()).toBe("9.9.9 (counterpart)");
    expect((await version.exited).code).toBe(0);

    const first = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(first, "live-a", "allow");
    expect(await first.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    first.child.stdin.end();
    expect((await first.exited).code).toBe(0);

    // A probe asked again hears the last recorded answer again.
    const again = converse(binary, ["--version"], { cwd: REPLAY_REPO });
    expect(await again.awaitLine()).toBe("9.9.9 (counterpart)");
    expect((await again.exited).code).toBe(0);

    // The second stream launch is the second recorded run, answered "deny".
    const second = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(second, "live-b", "deny");
    expect(await second.awaitLine(typed("result"))).toMatchObject({ behavior: "deny" });
    second.child.stdin.end();
    expect((await second.exited).code).toBe(0);

    const third = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    const exit = await third.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("no recorded invocation left");

    expect(NodeFS.readdirSync(pidDir)).toHaveLength(5);
  });

  it("takes answers to two open requests in either order, and still checks each", async () => {
    const twoOpen = (): string =>
      replayer.config("two-open", { tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`) })
        .binaryPath;
    const run = converse(twoOpen(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await askTwice(run);
    run.send(answer("asked-2", "deny"));
    run.send(answer("asked-1", "allow"));
    await run.awaitLine(
      (line) => typed("result")(line) && (line as { request_id?: string }).request_id === "asked-2",
    );
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const swapped = converse(twoOpen(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await askTwice(swapped);
    swapped.send(answer("asked-2", "allow"));
    swapped.send(answer("asked-1", "allow"));
    const exit = await swapped.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different behavior");
  });

  it("refuses a scenario that is not recorded", () => {
    expect(() => replayer.config("missing", { tmpDir: NodePath.join(ROOT, "nowhere") })).toThrow();
  });
});
