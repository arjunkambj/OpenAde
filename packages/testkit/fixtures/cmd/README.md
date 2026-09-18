# Command Code recordings

**Every directory here is a real recording of the real Command Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/cmd` (the operator's global install) |
| Version     | **1.55.1**                                              |
| Recorded on | **2026-09-18**                                          |
| Model       | `meta/muse-spark-1.3-contributor` (the account default) |
| Recorded by | `packages/testkit/scripts/record-cmd.mjs`               |

Each `manifest.json` carries the model its own frames name, so a recording made
on a different model says so rather than inheriting this table.

Each run was spawned with exactly the argv and environment
`packages/connector-cmd/src/spawn.ts` builds, in a throwaway git repo, with the
recording PreToolUse hook installed through the same
`.commandcode/settings.local.json` mechanism `config.ts` uses.

## Re-recording

Recording spends the operator's paid plan, so it is never run from CI:

```sh
node packages/testkit/scripts/record-cmd.mjs --list
node packages/testkit/scripts/record-cmd.mjs shell-allow
node packages/testkit/scripts/record-probe.mjs      # no model turns
```

`--model <id>` overrides the account default, and the recorder refuses any id
but the three the operator authorised — `meta/muse-spark-1.3-contributor` (the
default), `poolside/laguna-s-2.1-free` and
`inclusionai/ling-3.0-flash-sante:free` — before it spawns anything. Most of the
seventy models `--list-models` offers bill real money.

## What each directory holds

`manifest.json` is the index: the argv and env keys the run used, the exit code
and signal, the session id, stdout chunk arrival order, transcript growth
samples, hook count, plan files and touched files. Beside it:

| file                | what it is                                               |
| ------------------- | -------------------------------------------------------- |
| `stdout.ndjson`     | every NDJSON frame, in arrival order                     |
| `stderr.txt`        | `--verbose` stderr, including `session: <uuid>`          |
| `transcript.jsonl`  | the on-disk session transcript as it ended up            |
| `checkpoints.jsonl` | the `<id>.checkpoints.jsonl` the CLI wrote               |
| `hooks.json`        | every PreToolUse invocation: the CLI's stdin, our answer |

Multi-turn scenarios prefix each file with `turn1.` / `turn2.`.

## The scenarios

| directory         | what it proves                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `probe/`          | `status --json`, `--list-models`, `--version`, `--help`, bad model                           |
| `text/`           | a text-only answer; `text_delta` streaming                                                   |
| `shell-allow/`    | `shell_command` allowed through the hook — and still refused without `--yolo`                |
| `shell-deny/`     | the same call denied by the hook — `tool_hook_blocked`                                       |
| `shell-yolo/`     | the same call with `--yolo`; the hook still fires and the call runs                          |
| `file-edit/`      | `edit_file` against a real file                                                              |
| `plan/`           | `--permission-mode plan --yolo` writing a plan, then the accept follow-up                    |
| `plan-no-yolo/`   | plan mode without `--yolo`: the plan file itself is refused                                  |
| `plan-guard/`     | plan mode with `--yolo`, told to edit: the workspace stays untouched                         |
| `question/`       | `ask_user_question` with the connector's argv — the tool is withheld                         |
| `question-tools/` | the same with `--tools-enable ask_user_question` — it fires, and the hook sees the questions |
| `image/`          | an image attachment staged the way the connector stages one                                  |
| `mcp/`            | an `mcp__<server>__<tool>` call — PreToolUse fires for it                                    |
| `interrupt/`      | SIGINT mid-turn — exit 130, no `run_end`, no `result`                                        |
| `resume/`         | a second turn resuming the first session id                                                  |
| `max-turns/`      | `--max-turns` exhausted — exit 8, `subtype: "max_turns"`                                     |

## Putting them back on the wire

`packages/testkit/bin/replay-cmd.mjs` replays a recording as if it were `cmd`.
It has no behaviour of its own — it chooses nothing and synthesises nothing —
and it is what every test that used to drive an invented stand-in now spawns:

```ts
import { replayConfig } from "@OpenAde/testkit/replayCmdProcess";
const config = replayConfig("shell-yolo", { home: tempHome });
// → { binaryPath, extraEnv }: point a connector instance at it
```

It puts stdout back in the recorded chunk boundaries, appends the transcript
progressively into the project directory the harness really used, invokes the
project's installed PreToolUse hook at the recorded points with the recorded
payload and blocks on the answer, and exits with the recorded code. A test that
wants a different outcome names a different recording.

`probe-insufficient-credits.ndjson` is the one loose file: a real capture from
2026-09-15, when the account had no credits, and the only recording of
`run_error` and the exit-10 path. It cannot be made again now the plan is paid
for, so it is kept in the raw shape the first probe wrote it in.

## Scrubbing

Recordings are scrubbed on the way in: the operator's home directory becomes
`<HOME>`, the scratch root becomes `<SCRATCH>`, their account name becomes
`user`, and anything token-shaped becomes `<REDACTED>`. Session ids and trace
ids are left alone — they are per-run identifiers with no meaning off this
machine, and the tests match on them.

Conclusions drawn from these recordings are written up in
`docs/decisions/w2-cmd-frames.md`.
