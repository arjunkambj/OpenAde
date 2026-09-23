#!/usr/bin/env node
/**
 * Replays a recorded `sdk-stream` harness as if it were the CLI.
 *
 * This has no behaviour of its own. Everything it emits was captured from the
 * real CLI by `bin/stdio-tee.mjs` and finalised into
 * `packages/testkit/fixtures/<kind>/<scenario>/`. It chooses nothing,
 * synthesises nothing, and answers no question the recording does not already
 * answer — a test that needs a different outcome names a different recording.
 *
 * It is launched by the launcher `sdkStreamReplayer(kind).config` writes:
 *
 *     node replay-sdk-stream.mjs <config.json> <the argv the SDK passed>
 *
 * `config.json` names the scenario directory, the invocation counter's state
 * file and, optionally, a directory to drop a pid file into.
 *
 * Each launch takes the first unplayed invocation whose argv is of the same
 * class — `--version`, `auth status`, a stream-json run, or else the exact argv.
 * A probe that asks twice hears the last recorded answer again; a stream run
 * with none left to play is a divergence.
 *
 * A simple invocation prints its recorded stdout and stderr and exits with its
 * recorded code. A stream run walks its frames in order:
 *
 *   - a frame from the harness is written to its channel;
 *   - at a frame to the harness, the replay blocks on the next line of stdin and
 *     checks it is the same move: the same `type`; for a `control_request` the
 *     same `request.subtype`; for a `control_response` the same
 *     `response.subtype`, and when it answers a request the harness made, the
 *     same `request_id` — plus the same `behavior` for `can_use_tool` and the
 *     same `permissionDecision` for `hook_callback`. Answers to two open harness
 *     requests may arrive in either order; nothing else may;
 *   - the SDK's own request ids are random, so each recorded one is mapped to the
 *     live one at the moment it arrives, and the recorded `control_response`s
 *     to it are rewritten to carry the live id;
 *   - after the last frame it waits for stdin to close, then leaves the way the
 *     recorded run left, by exit code or by signal.
 *
 * Divergence is loud: anything the live side says that the recording did not,
 * or stdin closing while the recording still expects input, prints both sides
 * to stderr and exits 97. A recording made under one answer never plays out a
 * run that answered differently.
 *
 * `<HOME>` and `<SCRATCH>` in the recording are put back from this process's own
 * directories: its HOME, and the parent of its working directory.
 *
 * Plain node, no dependencies, never imported by the server bundle.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const DIVERGED = 97;

const [configPath, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(config.scenarioDir, "manifest.json"), "utf8"),
);
const label = `${manifest.kind}/${manifest.scenario}`;

const drained = (stream) => new Promise((resolve) => stream.write("", resolve));

const fail = async (message) => {
  process.stderr.write(`replay-sdk-stream: ${label}: ${message}\n`);
  await drained(process.stderr);
  process.exit(DIVERGED);
};

if (config.pidDir !== undefined) {
  fs.mkdirSync(config.pidDir, { recursive: true });
  fs.writeFileSync(path.join(config.pidDir, String(process.pid)), "", "utf8");
}

// ── which recorded invocation this launch is ───────────────────

const classOf = (args) => {
  if (args.includes("--version") || args.includes("-v")) return "version";
  if (args[0] === "auth" && args[1] === "status") return "auth-status";
  if (args.includes("stream-json")) return "stream";
  return `argv:${JSON.stringify(args)}`;
};

/** Holds the counter's lock for the length of `body`; launches can race. */
const withLock = (body) => {
  const lock = `${config.stateFile}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return body();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

const wanted = classOf(argv);
const chosen = withLock(() => {
  let played = [];
  try {
    played = JSON.parse(fs.readFileSync(config.stateFile, "utf8")).played ?? [];
  } catch {
    // The first launch of this scenario.
  }
  const candidates = manifest.invocations
    .map((invocation, index) => ({ invocation, index }))
    .filter(({ invocation }) => classOf(invocation.argv) === wanted);
  const next = candidates.find(({ index }) => !played.includes(index));
  const pick = next ?? (wanted === "stream" ? undefined : candidates.at(-1));
  if (pick !== undefined && next !== undefined) {
    fs.writeFileSync(config.stateFile, JSON.stringify({ played: [...played, pick.index] }), "utf8");
  }
  return pick;
});
if (chosen === undefined) {
  await fail(`no recorded invocation left to play for ${JSON.stringify(argv)}`);
}
const { invocation, index: invocationIndex } = chosen;

// ── the recording, with this machine's directories put back ────

const home = process.env.HOME ?? os.homedir();
const scratch = path.dirname(process.cwd());
const inJson = (text) => JSON.stringify(text).slice(1, -1);
const unscrub = (line) =>
  line.split("<HOME>").join(inJson(home)).split("<SCRATCH>").join(inJson(scratch));

const frames = fs
  .readFileSync(path.join(config.scenarioDir, invocation.file), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(unscrub(line)));

const lineOf = (data) => `${typeof data === "string" ? data : JSON.stringify(data)}\n`;

const write = (channel, data) =>
  new Promise((resolve) =>
    (channel === "stderr" ? process.stderr : process.stdout).write(lineOf(data), resolve),
  );

/** Leaves the way the recorded run left. */
const leave = async () => {
  await drained(process.stdout);
  await drained(process.stderr);
  if (invocation.signal !== null && invocation.signal !== undefined) {
    process.kill(process.pid, invocation.signal);
    // A signal whose default is not to terminate still ends the replay.
    setTimeout(() => process.exit(128), 1000);
    await new Promise(() => {});
  }
  process.exit(invocation.exitCode ?? 0);
};

if (wanted !== "stream") {
  for (const frame of frames) {
    if (frame.dir === "from-harness") await write(frame.channel, frame.data);
  }
  await leave();
}

// ── stdin, a line at a time ────────────────────────────────────

const pending = [];
let stdinClosed = false;
let wake = null;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  pending.push(line);
  wake?.();
});
lines.on("close", () => {
  stdinClosed = true;
  wake?.();
});

/** The next live line, parsed when it is JSON; null once stdin has closed. */
const nextLive = async () => {
  while (pending.length === 0) {
    if (stdinClosed) return null;
    await new Promise((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  const line = pending.shift();
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

// ── the walk ───────────────────────────────────────────────────

/** Requests the harness made, by recorded id → subtype. */
const harnessRequests = new Map();
const answered = new Set();
/** Answers that arrived ahead of an earlier open request's answer. */
const early = new Map();
/** The SDK's own request ids: recorded → live. */
const liveIds = new Map();

const isObject = (value) => value !== null && typeof value === "object";
const answerId = (data) =>
  isObject(data) && data.type === "control_response" ? data.response?.request_id : undefined;

/** Why `live` is not the move `recorded` was, or null when it is. */
const mismatch = (recorded, live) => {
  if (!isObject(recorded)) return live === recorded ? null : "a different line";
  if (!isObject(live)) return "not a JSON object";
  if (live.type !== recorded.type) return "a different type";
  if (recorded.type === "control_request" && live.request?.subtype !== recorded.request?.subtype) {
    return "a different control request";
  }
  if (recorded.type !== "control_response") return null;
  if (live.response?.subtype !== recorded.response?.subtype) return "a different response subtype";
  const id = recorded.response?.request_id;
  if (!harnessRequests.has(id)) return null;
  if (live.response?.request_id !== id) return "an answer to a different request";
  const said = (data) => data.response?.response;
  switch (harnessRequests.get(id)) {
    case "can_use_tool":
      return said(live)?.behavior === said(recorded)?.behavior ? null : "a different behavior";
    case "hook_callback":
      return said(live)?.hookSpecificOutput?.permissionDecision ===
        said(recorded)?.hookSpecificOutput?.permissionDecision
        ? null
        : "a different permissionDecision";
    default:
      return null;
  }
};

/** The live line that should be `recorded`, holding back early answers. */
const takeLive = async (recorded) => {
  const awaited = harnessRequests.has(answerId(recorded)) ? answerId(recorded) : undefined;
  if (awaited !== undefined && early.has(awaited)) {
    const live = early.get(awaited);
    early.delete(awaited);
    return live;
  }
  for (;;) {
    const live = await nextLive();
    const id = answerId(live);
    const heldBack =
      awaited !== undefined &&
      id !== awaited &&
      harnessRequests.has(id) &&
      !answered.has(id) &&
      !early.has(id);
    if (!heldBack) return live;
    early.set(id, live);
  }
};

/** A harness frame with the SDK's live request id where it answers one. */
const withLiveId = (data) => {
  const id = answerId(data);
  if (id === undefined || !liveIds.has(id)) return data;
  return { ...data, response: { ...data.response, request_id: liveIds.get(id) } };
};

for (const [position, frame] of frames.entries()) {
  if (frame.dir === "from-harness") {
    if (isObject(frame.data) && frame.data.type === "control_request") {
      harnessRequests.set(frame.data.request_id, frame.data.request?.subtype);
    }
    await write(frame.channel, withLiveId(frame.data));
    continue;
  }
  const live = await takeLive(frame.data);
  const where = `invocation ${invocationIndex + 1}, frame ${position + 1}`;
  if (live === null) {
    await fail(
      `${where}: stdin closed while the recording expects\n  recorded: ${lineOf(frame.data)}`,
    );
  }
  const why = mismatch(frame.data, live);
  if (why !== null) {
    await fail(
      `${where}: the live side sent ${why}\n  recorded: ${lineOf(frame.data).trimEnd()}\n  received: ${lineOf(live).trimEnd()}`,
    );
  }
  if (frame.data.type === "control_request") {
    liveIds.set(frame.data.request_id, live.request_id);
  }
  const id = answerId(frame.data);
  if (harnessRequests.has(id)) answered.add(id);
}

// The recording is played out: anything more the live side says is something
// the recorded run never heard.
const extra = await nextLive();
if (extra !== null) {
  await fail(
    `the recording has ended but the live side sent\n  received: ${lineOf(extra).trimEnd()}`,
  );
}
await leave();
