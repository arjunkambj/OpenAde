#!/usr/bin/env node
/**
 * Replays a recorded Command Code run as if it were the CLI.
 *
 * This has no behaviour of its own. Everything it emits was captured from the
 * real `cmd` 1.55.1 by `packages/testkit/scripts/record-cmd.mjs` and lives in
 * `packages/testkit/fixtures/cmd/<scenario>/`. It chooses nothing, synthesises
 * nothing, and answers no question the recording does not already answer — if a
 * test needs a different outcome it points at a different recording.
 *
 * What it does do is put the recording back on the wire the way the harness put
 * it there the first time:
 *
 *   - stdout arrives in the recorded chunk boundaries, so a reader meets the
 *     same half-written lines the connector's splitter met;
 *   - the session transcript is appended progressively, one flush per agent
 *     step, in the project directory the harness really used — which is *not*
 *     the one the connector's slug guesses;
 *   - the installed PreToolUse hook is invoked at the recorded points with the
 *     recorded payload, and the run blocks on its answer exactly as the CLI
 *     blocks on it;
 *   - the process exits with the recorded code and honours SIGINT.
 *
 * The non-model surfaces — `status --json`, `--list-models`, `--version`,
 * `--help` — are replayed from `fixtures/cmd/probe/`, which is the same CLI
 * answering for real.
 *
 * Environment:
 *   OPENADE_REPLAY_DIR        the recording directory (required for a turn)
 *   OPENADE_REPLAY_TURN       which recorded turn to play; default: the next
 *                             one, counted in OPENADE_REPLAY_STATE
 *   OPENADE_REPLAY_STATE      file holding that counter, so a second spawn in
 *                             the same session plays the second recorded turn
 *   OPENADE_REPLAY_PID_DIR    drop a file named after this pid, so a suite can
 *                             prove the process tree is gone
 *   OPENADE_REPLAY_ARGV_LOG   append this run's argv and cwd as one JSON line,
 *                             so a test can assert what the connector actually
 *                             handed the CLI
 *
 * Plain node, no dependencies, never imported by the server bundle.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cmd");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const readOr = (file, fallback = "") => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
};

// Every invocation, including the probe ones, so a test can assert the argv and
// environment the connector really builds rather than trust a description of it.
if (process.env.OPENADE_REPLAY_ARGV_LOG !== undefined) {
  try {
    fs.mkdirSync(path.dirname(process.env.OPENADE_REPLAY_ARGV_LOG), { recursive: true });
    fs.appendFileSync(
      process.env.OPENADE_REPLAY_ARGV_LOG,
      `${JSON.stringify({ argv, cwd: process.cwd() })}\n`,
      "utf8",
    );
  } catch {
    // A log we cannot write is not worth failing a replay over.
  }
}

// ── the recorded non-model surfaces ────────────────────────────

const probe = (name) => readOr(path.join(FIXTURES, "probe", `${name}.stdout.txt`));

if (has("--help") || has("-h")) {
  process.stdout.write(probe("help"));
  process.exit(0);
}
if (has("--version") || has("-V") || has("-v")) {
  process.stdout.write(probe("version"));
  process.exit(0);
}
if (has("--list-models")) {
  process.stdout.write(probe("list-models"));
  process.exit(0);
}
if (argv[0] === "status") {
  process.stdout.write(probe("status"));
  process.exit(0);
}
if (value("--model") === "definitely/not-a-real-model") {
  process.stderr.write(readOr(path.join(FIXTURES, "probe", "invalid-model.stderr.txt")));
  process.exit(1);
}

// ── the recording to play ──────────────────────────────────────

const recordingDir = process.env.OPENADE_REPLAY_DIR;
if (recordingDir === undefined || recordingDir === "") {
  process.stderr.write("replay-cmd: set OPENADE_REPLAY_DIR to a recording directory\n");
  process.exit(1);
}
const manifest = JSON.parse(readOr(path.join(recordingDir, "manifest.json"), "null"));
if (manifest === null) {
  process.stderr.write(`replay-cmd: no manifest.json in ${recordingDir}\n`);
  process.exit(1);
}

/**
 * Which recorded turn this spawn is. A test may pin one; otherwise the counter
 * advances, so the second process of a session plays the second recorded turn —
 * which is what a second message does to the real CLI.
 */
const turnIndex = (() => {
  const pinned = process.env.OPENADE_REPLAY_TURN;
  if (pinned !== undefined && pinned !== "") {
    return Number(pinned);
  }
  const state = process.env.OPENADE_REPLAY_STATE;
  if (state === undefined || state === "") {
    return 0;
  }
  const next = Number(readOr(state, "0")) || 0;
  try {
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, String(next + 1), "utf8");
  } catch {
    // A counter we cannot write just replays the first turn.
  }
  return next;
})();

const turn = manifest.turns[Math.min(turnIndex, manifest.turns.length - 1)];
const file = (name) => (name === undefined ? null : path.join(recordingDir, name));

const cwd = process.cwd();
const home = process.env.HOME ?? os.homedir();

/**
 * Recordings are scrubbed: the operator's home is `<HOME>` and the throwaway
 * workspace's parent is `<SCRATCH>`. Putting this run's own directories back is
 * what makes a recorded path point at a file that exists here.
 */
const unscrub = (text) =>
  text.split("<HOME>").join(home).split("<SCRATCH>").join(path.dirname(cwd));

const stdout = unscrub(readOr(file(turn.files.stdout)));
const stderrText = unscrub(readOr(file(turn.files.stderr)));
const transcriptLines = unscrub(readOr(file(turn.files.transcript)))
  .split("\n")
  .filter((line) => line.length > 0);
const recordedHooks = JSON.parse(unscrub(readOr(file(turn.files.hooks), "[]")));

if (process.env.OPENADE_REPLAY_PID_DIR !== undefined) {
  fs.mkdirSync(process.env.OPENADE_REPLAY_PID_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.OPENADE_REPLAY_PID_DIR, String(process.pid)), "", "utf8");
}

// ── the transcript, where the harness really put it ────────────

/**
 * The recorded project directory, under this run's HOME. Deliberately the real
 * one and not the connector's slug guess: reproducing the mismatch is the point,
 * because that is what the session's locator has to survive.
 */
const transcriptPath = (() => {
  if (turn.transcriptPath === null || turn.transcriptPath === undefined) {
    return null;
  }
  const directory = path.join(
    home,
    ".commandcode",
    "projects",
    path.basename(path.dirname(turn.transcriptPath)),
  );
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, path.basename(turn.transcriptPath));
})();

let transcriptWritten = 0;
const flushTranscript = (upTo) => {
  if (transcriptPath === null) {
    return;
  }
  const target = Math.min(upTo, transcriptLines.length);
  if (target <= transcriptWritten) {
    return;
  }
  fs.appendFileSync(
    transcriptPath,
    `${transcriptLines.slice(transcriptWritten, target).join("\n")}\n`,
    "utf8",
  );
  transcriptWritten = target;
};

/**
 * How many transcript lines existed at each flush, from the recording's growth
 * samples. The transcript is written once per completed message — one flush per
 * agent step — so these line up with the `turn_end` frames.
 */
const growthLines = (turn.transcriptGrowth ?? []).map((sample) => sample.lines);

// ── the PreToolUse hook, invoked the way the harness invokes it ─

/** The project's hook commands whose matcher accepts `toolName` (spec 5.5). */
const hookCommandsFor = (toolName) => {
  const settings = JSON.parse(
    readOr(path.join(cwd, ".commandcode", "settings.local.json"), "null"),
  );
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) {
    return [];
  }
  const commands = [];
  for (const entry of entries) {
    const matcher = typeof entry?.matcher === "string" ? entry.matcher : ".*";
    let matches = true;
    try {
      matches = matcher === "" || new RegExp(matcher).test(toolName);
    } catch {
      matches = true;
    }
    if (!matches || !Array.isArray(entry?.hooks)) {
      continue;
    }
    for (const hook of entry.hooks) {
      if (typeof hook?.command === "string" && hook.command !== "") {
        commands.push(hook.command);
      }
    }
  }
  return commands;
};

/**
 * Hands one recorded hook payload to whatever hook this project has installed
 * and blocks on the answer, as the CLI does. The recording's own answer is what
 * the rest of the run was produced under, so that is the branch that plays; a
 * live answer that disagrees is reported on stderr rather than silently
 * producing a run that never happened.
 */
const askHook = (recorded) => {
  const payload = {
    ...recorded.stdin,
    session_id: turn.sessionId ?? recorded.stdin.session_id,
    transcript_path: transcriptPath ?? recorded.stdin.transcript_path,
    cwd,
  };
  const recordedDecision = recorded.answer?.hookSpecificOutput?.permissionDecision ?? "allow";
  for (const command of hookCommandsFor(payload.tool_name)) {
    const result = spawnSync(command, {
      shell: true,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        COMMANDCODE_PROJECT_DIR: cwd,
        COMMANDCODE_SESSION_ID: payload.session_id,
        COMMANDCODE_HOOK_EVENT: "PreToolUse",
        COMMANDCODE_CWD: cwd,
      },
    });
    const live =
      result.status === 2
        ? "deny"
        : (() => {
            try {
              return JSON.parse((result.stdout ?? "").trim())?.hookSpecificOutput
                ?.permissionDecision;
            } catch {
              return undefined;
            }
          })();
    if (live !== undefined && live !== recordedDecision) {
      process.stderr.write(
        `replay-cmd: the hook answered "${live}" but this recording was made under "${recordedDecision}" — playing the recorded branch. Point the test at the recording that matches.\n`,
      );
    }
  }
};

/** Recorded hook calls still to make, in order, keyed by the call they gate. */
const pendingHooks = [...recordedHooks];
const hookFor = (toolCallId) => {
  const index = pendingHooks.findIndex(
    (call) => call.stdin?.tool_use_id === toolCallId || call.stdin?.tool_use_id === undefined,
  );
  return index === -1 ? null : pendingHooks.splice(index, 1)[0];
};

// ── replay ─────────────────────────────────────────────────────

let interrupted = false;
const onInterrupt = () => {
  interrupted = true;
};
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

process.stderr.write(stderrText);

/**
 * The recorded chunk boundaries, as character counts. Replaying them is what
 * hands a reader the same partial lines the connector's splitter had to hold.
 */
const chunkSizes = (turn.stdoutChunks ?? []).map((chunk) => chunk.chars);

/**
 * Walks the recorded stdout line by line, doing at each frame what the harness
 * did: call the hook before a gated tool call, flush the transcript at an agent
 * step boundary. Output is re-cut into the recorded chunks afterwards.
 */
const lines = stdout.split("\n");
const emitted = [];
let steps = 0;
for (const line of lines) {
  if (interrupted) {
    break;
  }
  if (line.length === 0) {
    continue;
  }
  let frame = null;
  try {
    frame = JSON.parse(line);
  } catch {
    // A line the recording could not parse either — replay it verbatim.
  }
  const event = frame?.type === "event" ? frame.event : null;
  if (event?.type === "tool_queued") {
    const recorded = hookFor(event.toolCallId);
    if (recorded !== null) {
      askHook(recorded);
    }
  }
  emitted.push(line);
  if (event?.type === "turn_end") {
    steps += 1;
    flushTranscript(growthLines[steps - 1] ?? transcriptLines.length);
  }
  if (event?.type === "run_end") {
    flushTranscript(transcriptLines.length);
  }
}

const text = emitted.length === 0 ? "" : `${emitted.join("\n")}\n`;
let offset = 0;
for (const size of chunkSizes) {
  if (offset >= text.length) {
    break;
  }
  process.stdout.write(text.slice(offset, offset + size));
  offset += size;
}
if (offset < text.length) {
  process.stdout.write(text.slice(offset));
}

/**
 * A recording taken by interrupting a live run ends with the process still
 * working — that is what was recorded — so the replay waits here for the SIGINT
 * that ended the original, rather than inventing an ending it never had.
 */
const awaitingInterrupt = turn.interrupted === true && !interrupted;
if (awaitingInterrupt) {
  const idle = setInterval(() => {
    if (interrupted) {
      clearInterval(idle);
      process.exit(turn.exitCode ?? 130);
    }
  }, 10);
} else {
  flushTranscript(transcriptLines.length);
  process.exit(interrupted ? 130 : (turn.exitCode ?? 0));
}
