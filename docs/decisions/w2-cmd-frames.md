# W2 — Command Code frames: day-one probe results

Date: 2026-09-18. Probe: `npx -y command-code@1.54.0` (no `cmd` on PATH —
brief says `npm i -g command-code`; not installed globally).

## Status

`cmd status --json` → authenticated as `arjunkambj`, version 1.54.0,
default model `stealth/ox-alpha`. `--list-models` returns 70 models.

## Credits: still missing

A minimal headless turn
(`-p "Reply with exactly: ok" --output-format json --verbose -t
--skip-onboarding --no-auto-update --max-turns 1 --no-session`) fails at the
model call:

    run_error: POST /alpha/generate → 400 error: You have insufficient credits
    result.subtype = error, error: "https://commandcode.ai/billing"

The account needs credits at https://commandcode.ai/billing before the
section-5.7 unknowns can be verified live (text deltas? transcript growth
timing? ask_user_question in print mode?).

The failed run's real frames are captured at
`packages/testkit/fixtures/cmd/probe-insufficient-credits.ndjson`.

## What is verified without credits

- Frame envelope: every line is `{"type":"event","event":{...}}` except the
  final `{"type":"result",...}` line.
- Verified event types from the failed run: `run_start` (carries
  `sessionId`), `turn_start` (`turnNumber`), `message_start`,
  `model_request_start` (`model`), `model_trace` (`traceId`), `run_error`
  (`error.name`, `error.message`), `run_end` (`result` with `finalText`,
  `stopReason`, `turnCount`, `usage`, `nextState` = full message list).
- `result` line: `{type:"result", subtype:"error"|..., sessionId, usage,
durationMs, finalText, error}`.
- `run_end.result.nextState` is the authoritative end-of-turn snapshot —
  the translator treats it as such even when streaming frames are sparse.
- `--session <id>` resumes a session; `--permission-mode
standard|plan|auto-accept` and `--yolo` exist; exit codes per spec §5.1.

## Open until credits land (spec §5.7)

1. Whether assistant text streams as deltas or only lands in `run_end` /
   transcript. Connector handles both (delta → `content.delta`, otherwise
   transcript-tail → `item.*`).
2. Whether the transcript file grows during a turn or only at turn end —
   the transcript tailer assumes per-message appends.
3. `ask_user_question` in print mode — the connector installs a PreToolUse
   hook on it regardless (spec fallback).
4. Whether PreToolUse fires for `agent` subagent calls and `mcp__*` tools.

## Running without an account: `packages/testkit/bin/fake-cmd.mjs`

Everything above is still true — there are no credits and no recorded turn — so
the connector is built and verified against a stand-in binary instead. It is a
plain node executable with no dependencies, never imported by the server bundle,
and it speaks the slice of the CLI the connector uses:

```
cmd status --json            # authenticated, version, user, provider, model
cmd --list-models            # the table below
cmd --help | --version
cmd -p "<prompt>" --output-format json --verbose [--session <id>]
                             # one turn: NDJSON frames (§5.2) on stdout, the
                             # transcript appended under $HOME (§5.3), the
                             # project's PreToolUse hook invoked for tool calls
                             # (§5.5), SIGINT → exit 130
```

**Use it to run the whole app without an account.** Set the connector
instance's binary path to the file:

```jsonc
// Settings → Connectors → Command Code → binary path
"/path/to/OpenAde/packages/testkit/bin/fake-cmd.mjs"
```

Then send a message. The fake picks its scenario from the prompt text, so the
message decides what the turn does:

| the prompt contains | the turn does                                              |
| ------------------- | ---------------------------------------------------------- |
| `question`          | `ask_user_question` — the card, answered through the hook  |
| `plan`              | writes `~/.commandcode/plans/<file>.md` + the index entry  |
| `edit`              | `edit_file` — really writes `fake-cmd-edit.txt` in the cwd |
| `tool` or `shell`   | `shell_command`, gated by the PreToolUse hook              |
| anything else       | a short text answer                                        |

Env knobs for tests: `OPENADE_FAKE_SESSION_ID` pins the session id,
`OPENADE_FAKE_EXIT_CODE` overrides the exit code, `OPENADE_FAKE_HANG=1` keeps
the process alive after the frames (for interrupt tests), and
`OPENADE_FAKE_PID_DIR` drops a file named after the pid so a suite can prove the
process tree is gone.

It is what `apps/server/src/hooks/cmdConformance.test.ts` drives — the whole
production round trip, hook script through the bridge and back, minus the model.

`packages/testkit/fixtures/cmd/list-models.txt` is the table the fake prints and
`parseModelList` is tested against. It is **reconstructed, not captured**: the
model ids and the "70 models / (default) / FREE" shape come from spec §5.1 and
from the probe run above, but the column layout is a guess. Recapture it against
a real binary when one is available — `probe.test.ts` will say what breaks.

## Two connector decisions worth writing down

1. **The `openade` MCP entry goes in `~/.commandcode/projects/<slug>/mcp.json`,
   not `<projectRoot>/.mcp.json`.** Both are real local scopes (§5.3), but the
   second lives inside the user's git repo and would be committed with a dead
   loopback URL in it. Section 8 step 2 names the first one; we follow it.
2. **Both files we write into a user's project are reverted when the session
   closes** — the PreToolUse block and the MCP entry — but only while the file
   still hashes to what we wrote, and only once the last session using that
   project has closed. A file edited since is left alone; a file we created and
   emptied is deleted.
