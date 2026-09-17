# Command Code recordings

**Every directory here is a real recording of the real Command Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|              |                                                              |
| ------------ | ------------------------------------------------------------ |
| CLI          | `/opt/homebrew/bin/cmd` (the operator's global install)       |
| Version      | **1.55.1**                                                    |
| Recorded on  | **2026-09-18**                                                |
| Model        | `meta/muse-spark-1.3-contributor` (the account default)       |
| Recorded by  | `packages/testkit/scripts/record-cmd.mjs`                     |

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

`--model <id>` overrides the account default. Only models the operator has
authorised may be used: `meta/muse-spark-1.3-contributor` (the default),
`poolside/laguna-s-2.1-free` and `inclusionai/ling-3.0-flash-sante:free`.

## What each directory holds

`manifest.json` is the index: the argv and env keys the run used, the exit code
and signal, the session id, stdout chunk arrival order, transcript growth
samples, hook count, plan files and touched files. Beside it:

| file                  | what it is                                              |
| --------------------- | ------------------------------------------------------- |
| `stdout.ndjson`       | every NDJSON frame, in arrival order                    |
| `stderr.txt`          | `--verbose` stderr, including `session: <uuid>`         |
| `transcript.jsonl`    | the on-disk session transcript as it ended up           |
| `checkpoints.jsonl`   | the `<id>.checkpoints.jsonl` the CLI wrote              |
| `hooks.json`          | every PreToolUse invocation: the CLI's stdin, our answer |

Multi-turn scenarios prefix each file with `turn1.` / `turn2.`.

## The scenarios

| directory         | what it proves                                                       |
| ----------------- | -------------------------------------------------------------------- |
| `probe/`          | `status --json`, `--list-models`, `--version`, `--help`, bad model   |
| `text/`           | a text-only answer; `text_delta` streaming                           |
| `shell-allow/`    | `shell_command` allowed through the hook — and still refused without `--yolo` |
| `shell-deny/`     | the same call denied by the hook — `tool_hook_blocked`               |
| `shell-yolo/`     | the same call with `--yolo`; the hook still fires and the call runs  |
| `file-edit/`      | `edit_file` against a real file                                      |
| `plan/`           | `--permission-mode plan --yolo` writing a plan, then the accept follow-up |
| `plan-no-yolo/`   | plan mode without `--yolo`: the plan file itself is refused          |
| `plan-guard/`     | plan mode with `--yolo`, told to edit: the workspace stays untouched |
| `question/`       | `ask_user_question` with the connector's argv — the tool is withheld |
| `question-tools/` | the same with `--tools-enable ask_user_question` — it fires, and the hook sees the questions |
| `image/`          | an image attachment staged the way the connector stages one         |
| `mcp/`            | an `mcp__<server>__<tool>` call — PreToolUse fires for it           |
| `interrupt/`      | SIGINT mid-turn — exit 130, no `run_end`, no `result`               |
| `resume/`         | a second turn resuming the first session id                         |
| `max-turns/`      | `--max-turns` exhausted — exit 8, `subtype: "max_turns"`            |

## Scrubbing

Recordings are scrubbed on the way in: the operator's home directory becomes
`<HOME>`, the scratch root becomes `<SCRATCH>`, their account name becomes
`user`, and anything token-shaped becomes `<REDACTED>`. Session ids and trace
ids are left alone — they are per-run identifiers with no meaning off this
machine, and the tests match on them.

Conclusions drawn from these recordings are written up in
`docs/decisions/w2-cmd-frames.md`.
