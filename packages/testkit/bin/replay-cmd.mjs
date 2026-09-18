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
 *     the one the connector's slug guesses. The flushes are interleaved with
 *     the stdout chunks on the recording's own timestamps, so the file is
 *     absent when the run starts, appears partway through, and takes its last
 *     append with `run_end` — the ordering the translator's late `costUsd`
 *     drain exists for;
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

/** This run's working directory and home, needed before the recording loads. */
const cwdOf = () => process.cwd();
const home = process.env.HOME ?? os.homedir();

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
/**
 * `cmd mcp add-json` / `cmd mcp remove`, implemented rather than replayed.
 *
 * These are the one surface whose effect is a function of the *cwd* and not of
 * the model: the real CLI files the entry under a slug of the workspace path
 * that only it knows how to spell, which is exactly why the connector asks it
 * to write the file instead of writing it itself. A recording cannot supply a
 * directory name that differs per run, so the replay keeps its own
 * deterministic slug — `replaySlugFor` — and the tests that care about the
 * real one assert against the real CLI.
 */
const replaySlugFor = (dir) => {
  const slug = dir.toLowerCase().replaceAll("/", "-");
  return slug.startsWith("-") ? slug.slice(1) : slug;
};

if (argv[0] === "mcp") {
  const file = path.join(home, ".commandcode", "projects", replaySlugFor(cwdOf()), "mcp.json");
  const config = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  })();
  const servers = { ...config.mcpServers };
  if (argv[1] === "add-json") {
    try {
      servers[argv[2]] = JSON.parse(argv[3] ?? "{}");
    } catch {
      process.exit(1);
    }
  } else if (argv[1] === "remove") {
    delete servers[argv[2]];
  } else {
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`,
    "utf8",
  );
  process.exit(0);
}
if (argv[0] === "status") {
  process.stdout.write(probe("status"));
  process.exit(0);
}
/**
 * The bad-model rejection, replayed for the id the probe recording was made
 * with — read out of the recording rather than written down here, so nothing in
 * this file knows a model name of its own and a re-recording with a different
 * made-up id keeps working.
 */
const probeManifest = JSON.parse(readOr(path.join(FIXTURES, "probe", "manifest.json"), "null"));
const invalidModel = (() => {
  const probes = probeManifest?.probes ?? [];
  const recorded = probes.find((entry) => entry.name === "invalid-model");
  const args = recorded?.args ?? [];
  const at = args.indexOf("--model");
  return at === -1 ? null : args[at + 1];
})();
if (invalidModel !== null && value("--model") === invalidModel) {
  process.stderr.write(readOr(path.join(FIXTURES, "probe", "invalid-model.stderr.txt")));
  process.exit(probeManifest.probes.find((entry) => entry.name === "invalid-model")?.exitCode ?? 1);
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

const cwd = cwdOf();

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
 * The recording's transcript growth samples: how many lines existed, and the
 * millisecond the sampler saw them. The transcript is written once per
 * completed message — one flush per agent step — and the last sample of every
 * recording lands within milliseconds of the last stdout chunk, which is what
 * "the final flush arrives with `run_end`" means in practice.
 */
const growthSamples = (turn.transcriptGrowth ?? []).map((sample) => ({
  at: sample.at ?? 0,
  lines: sample.lines,
}));

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
 * The recorded stdout chunks — each a character count and the millisecond it
 * arrived at. Replaying the boundaries is what hands a reader the same partial
 * lines the connector's splitter had to hold; replaying the times is what puts
 * the transcript's flushes back where they fell between them.
 */
const chunks = turn.stdoutChunks ?? [];

let chunkIndex = 0;
let growthIndex = 0;
let buffered = "";

/** Every recorded transcript flush the recording timed at or before `at`. */
const flushesUpTo = (at) => {
  while (growthIndex < growthSamples.length && growthSamples[growthIndex].at <= at) {
    flushTranscript(growthSamples[growthIndex].lines);
    growthIndex += 1;
  }
};

/**
 * Writes out every whole recorded chunk the buffer can now fill, each preceded
 * by the transcript flushes that landed before it.
 *
 * This ordering is the point of the file. The transcript is not written ahead
 * of the run: it appears seconds in, grows once per completed message, and its
 * last flush lands *with* `run_end` — which is why the connector drains it
 * again at the end rather than trusting its tailer. A replay that wrote the
 * whole transcript first would hand the tailer a finished file to skip past,
 * and no test would ever exercise the live path or the late `costUsd`.
 */
const drain = async () => {
  while (chunkIndex < chunks.length && buffered.length >= chunks[chunkIndex].chars) {
    const chunk = chunks[chunkIndex];
    chunkIndex += 1;
    flushesUpTo(chunk.at);
    process.stdout.write(buffered.slice(0, chunk.chars));
    buffered = buffered.slice(chunk.chars);
    // Hand the loop back so the pipe really delivers this chunk before the
    // next flush appends to the transcript. No timer: the order is the
    // recording's, the pace is as fast as the event loop turns.
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// ── the files the run left behind ──────────────────────────────

/**
 * Plan markdown and workspace edits, put back where the run put them.
 *
 * These are side effects of the recorded run exactly as the transcript is, and
 * the recorder captured their bytes; replaying the frames without them
 * describes a turn whose tool calls all succeeded and yet changed nothing. Two
 * things then cannot be tested at all: a plan turn, because the connector
 * proposes the plan by reading the file the run wrote, and a checkpoint,
 * because two snapshots of an untouched worktree have no diff between them.
 *
 * They land *during* the run rather than before it, for the same reason the
 * transcript does: the connector only accepts a plan file whose mtime is later
 * than the spawn, which is how a plan this turn wrote is told from one sitting
 * in the shared directory since last month.
 */
const writeRecordedFiles = () => {
  for (const plan of turn.plans ?? []) {
    if (plan.content === null || plan.content === undefined) {
      continue;
    }
    const directory = path.join(home, ".commandcode", "plans");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, plan.name), unscrub(plan.content), "utf8");
  }
  for (const touched of turn.touchedFiles ?? []) {
    const target = path.join(cwd, touched.name);
    if (touched.content === null || touched.content === undefined) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, unscrub(touched.content), "utf8");
  }
};

/** Written once, at the first tool result — the earliest the run could have. */
let filesWritten = false;
const writeRecordedFilesOnce = () => {
  if (filesWritten) {
    return;
  }
  filesWritten = true;
  writeRecordedFiles();
};

/**
 * Walks the recorded stdout line by line, doing at each frame what the harness
 * did: call the hook before a gated tool call, and hand the line to the chunked
 * writer, which interleaves the transcript's growth with it.
 */
const replay = async () => {
  for (const line of stdout.split("\n")) {
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
    // A completed tool call is the moment the run's own writes had landed.
    // A plan turn takes no tool calls the hook sees, so `message_end` stands
    // in for it there.
    if (event?.type === "tool_completed" || event?.type === "message_end") {
      writeRecordedFilesOnce();
    }
    buffered += `${line}\n`;
    await drain();
  }
  // Whatever the recorded chunk sizes did not account for — a run cut short by
  // SIGINT, or a final chunk the sampler merged.
  if (buffered.length > 0) {
    process.stdout.write(buffered);
    buffered = "";
  }
};

await replay();

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
  // A run that produced no tool call and no message still wrote whatever the
  // recorder found; an interrupted one is left as the SIGINT left it.
  if (!interrupted) {
    writeRecordedFilesOnce();
  }
  flushTranscript(transcriptLines.length);
  process.exit(interrupted ? 130 : (turn.exitCode ?? 0));
}
