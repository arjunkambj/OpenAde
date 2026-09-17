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
