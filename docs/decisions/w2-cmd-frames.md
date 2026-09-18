# W2 — what the Command Code harness actually does

Date: **2026-09-18**. Binary: `/opt/homebrew/bin/cmd`, **version 1.55.1**, the
operator's own global install. Account authenticated, default model
`meta/muse-spark-1.3-contributor`, 70 models listed.

Everything below was observed on real runs. They are recorded — argv, stdout
frames with their arrival chunks, stderr, the on-disk transcript as it grew, the
checkpoints file, every PreToolUse invocation with both halves of the
conversation, the plan files and the files each turn touched — under
`packages/testkit/fixtures/cmd/`, one directory per scenario, with
`packages/testkit/fixtures/cmd/README.md` as the index. Nothing in this document
is inferred from documentation.

Recorded by `packages/testkit/scripts/record-cmd.mjs`, which spawns the CLI with
exactly the argv and environment `packages/connector-cmd/src/spawn.ts` builds.
Replayed by `packages/testkit/bin/replay-cmd.mjs`.

## The answers to spec §5.7

**1. Does `--output-format json` stream assistant text deltas?**
Yes. `text_delta` carries `{delta: "<text>"}` and `thinking_delta` the same for
reasoning; `message_update` re-sends the whole message after every delta, and
`message_end` carries the finished content blocks. `fixtures/cmd/text/` is one
`text_delta` for a one-word answer; `fixtures/cmd/plan/turn1` has eleven.

**2. Does the transcript JSONL grow during the turn?**
It grows, but nowhere near live. The file does not exist at `run_start` — it
appears seconds in, already holding the run's first lines — and thereafter it is
appended **once per completed message**, at each agent-step boundary, with the
last flush landing _with_ `run_end`. A single-round-trip turn writes it exactly
once, at the end (`text/`: one growth sample at 3851ms of a 3851ms run); a
three-step turn writes it three times (`shell-allow/`).

So the transcript is one whole model round trip behind the frames and cannot
drive a live UI. The frames are the live source; the transcript is history — what
survives a restart, what carries `usage.costUsd`, and what a resumed session
reads to pick up where a dead one stopped.

**3. What does `ask_user_question` do in print mode?**
It is **withheld**. `fixtures/cmd/question/` is the connector's own argv with a
prompt that insists on the tool: the model cannot reach it and asks its question
as prose, which no card renders and no answer returns to.

`cmd --help` has the way out — `--tools-enable <names>`, "enable specific
withheld tools by name". With it (`fixtures/cmd/question-tools/`) the tool fires
and PreToolUse receives the real payload:

```json
{
  "questions": [
    {
      "header": "Indent style",
      "question": "Do you prefer tabs or spaces?",
      "options": [
        { "label": "Tabs", "description": "Use tab characters for indentation." },
        { "label": "Spaces", "description": "Use space characters for indentation." }
      ]
    }
  ]
}
```

The spec's fallback works exactly as designed: deny the tool, put the user's
answers in `permissionDecisionReason`. **Every turn now passes
`--tools-enable ask_user_question`.** Only that one — `--tools-all` would also
un-withhold whatever else a headless run hides, sight unseen.

**4. How are images attached in print mode?**
There is still no flag, and the fallback of `docs/decisions/w10-attachments.md`
works end to end. `fixtures/cmd/image/` stages a PNG the way the server stages an
upload, passes its directory as `--add-dir`, and names it in the prompt as
`Attachment (image/png): <absolute path>`. The model calls `read_file` on it; the
harness answers with `Read image red.png and attached it below for viewing
(618 B, image/jpeg)` plus a base64 image block — it transcodes to JPEG — and the
model answers with the colour of the pixels.

**5. `--permission-mode` accepted values.**
`--help` lists `standard, plan, auto-accept`. What the _hook_ is told in
`permission_mode` is neither: it is `default` on an ordinary run and `bypass`
under `--yolo`.

**6. Is the plan file written before `run_end`, and does `run_end` reference it?**
The plan file is written mid-run by an ordinary `write_file` call, and nothing in
`run_end` references it. Two consequences, both of which broke plan mode:

- **`--permission-mode plan` alone cannot write it — and that is the point.**
  Print mode refuses writes and shell without `--yolo` whatever a hook answered,
  and that refusal covers the plan file the model is told to write.
  `fixtures/cmd/plan-no-yolo/`: the model reads the repo, drafts the plan, tries
  to save it, and is told the tool "requires permissions. Use --yolo ... to
  enable file writes and shell commands in print mode".

  **A plan turn runs with no PreToolUse hook at all.** Plan mode skips
  PreToolUse entirely: `hookCount` is 0 in all four plan recordings, and
  `plan-guard`'s `read_file` produced no hook although the same tool fires one
  in an ordinary run (`fixtures/cmd/file-edit/`). So none of the permission
  ladder runs there — not the user's `deny` rules, not its own "plan mode is
  read-only", not the sensitive-path prompt. Our gate is not merely unaffected
  by `--yolo` in plan mode; it was never present.

  Adding `--yolo` on top therefore removed the last thing standing: the
  print-mode refusal. `fixtures/cmd/plan-guard/` and `fixtures/cmd/plan-write/`
  are that experiment — plan mode with `--yolo`, told outright to mutate. Both
  left the workspace untouched, which is two observations of good behaviour and
  not an enforcement mechanism, in a mode the UI labels "Plan first".

  **So a plan turn is the one turn spawned without `--yolo`** (`turnArgs.ts`),
  and the plan survives the refusal anyway: the whole body of the refused
  `write_file` is in the `tool_queued` frame that announced the call, so the
  connector saves the file itself (`plans.ts`) and proposes it as before. The
  refused write is shown as a saved plan rather than a red failed row.
  `recordedFrames.test.ts` still holds `plan-guard` and `plan-write` to
  `touchedFiles: []` and all four to `hookCount: 0`, so a CLI release that
  starts firing PreToolUse in plan mode says so on the next run.

- **`plans-index.json` is not updated by a headless run.** In `fixtures/cmd/plan/`
  the plan lands in `~/.commandcode/plans/` while the index keeps the two entries
  a pair of interactive sessions left in it in August. An index-only lookup finds
  nothing for every plan turn this connector runs, so `readPlanProposal` falls
  back to the newest plan markdown whose mtime is at or after the moment the turn
  was spawned.

**7. Does PreToolUse fire for `agent` subagent calls and for MCP tools?**
For MCP tools, yes. `fixtures/cmd/mcp/` registers a trivial stdio server through
`cmd mcp add-json --scope project` and the hook is invoked with
`tool_name: "mcp__rec__echo"` and the server-defined input; the `.*` matcher
covers it.

For subagents, **once — for the delegation, and never again**.
`fixtures/cmd/subagent/` delegates a file read with `--tools-all`. PreToolUse
fires exactly one time, with `tool_name: "agent"` and the subagent's own brief as
the input:

```json
{
  "description": "Read note.txt file",
  "prompt": "Read the file note.txt … report exactly what it says."
}
```

The subagent then ran `read_file` and **no hook fired for it**. The whole of the
evidence is three frames the connector had never seen:

| frame               | what it carries                                   |
| ------------------- | ------------------------------------------------- |
| `subagent_start`    | `toolCallId`, `subagentType` (`general`), a title |
| `subagent_progress` | one per inner tool call: `toolName`, `toolInput`  |
| `subagent_stop`     | `tokensUsed` for the whole delegation             |

Two consequences the approval design has to own:

- **Approving an `agent` call approves everything it goes on to do.** The gate
  is the delegation, not the work; the prompt in that one payload is all the
  user gets to judge. Anything stricter would have to come from us, not from a
  hook the harness never calls.
- **`subagent_progress` is the only visibility there is.** All three frames map
  onto the `task` row the `agent` call opened — the kind of agent, each inner
  tool as it is reached for, then the cost — and `tool_completed` replaces that
  row with the subagent's answer. Unread, the row would sit silent for the whole
  delegation.

## What the frames really are

Fifteen event types the connector did not read, all of them now mapped
(`packages/connector-cmd/src/translate.ts`, asserted for every recording by
`recordedFrames.test.ts`, which fails if anything reaches `event.unmapped`):

| frame                                                    | what it carries                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `message_update`                                         | the whole message so far, after every delta                      |
| `message_end`                                            | the finished content blocks                                      |
| `model_request_end`                                      | `model`, `usage`, `stopReason` (`stop` / `tool_calls`), `effort` |
| `turn_end`                                               | `turnNumber`, `hadToolCalls`, `usage` for that agent step        |
| `tool_queued`                                            | `toolCallId`, `toolName`, **`input`**                            |
| `tool_running`                                           | `toolCallId`, `toolName`, `description` — which is always `null` |
| `tool_update`                                            | `partial`, a long-running tool's output so far                   |
| `tool_completed`                                         | `result` (text and image blocks), `deferred`                     |
| `tool_hooks`                                             | the hook's verdict: `phase`, `outcome: {kind, text}`             |
| `tool_hook_blocked`                                      | `hookOutput` — the refusal the model is shown                    |
| `thinking_start` / `thinking_delta` / `thinking_end`     | reasoning, streamed then whole                                   |
| `subagent_start` / `subagent_progress` / `subagent_stop` | a delegation's kind, each inner tool call, its cost              |

Three things about them that the old mapping got wrong:

- **A turn is a process, not an agent step.** `turn_start`/`turn_end` count model
  round trips — three of them inside one `shell-allow` turn. One user turn is
  `run_start` to `run_end`, which is what spec §8 step 5 says.
- **The input lives on `tool_queued`.** `tool_running` carries no input and a
  null description, so a row built from it shows an empty command.
- **A blocked call still gets an ordinary `tool_result`** in the transcript, with
  no `is_error`, because the refusal is what the model is told. The frames are
  the authority on whether a call ran.

`run_end.result.nextState.messages` remains the authoritative end-of-turn
message list, and `result.usage` the turn's total. Cost appears in exactly one
place: the transcript's per-assistant `usage.costUsd`.

## Permissions, and the bug that mattered most

`--yolo` does **not** skip PreToolUse. `fixtures/cmd/shell-yolo/` is a
`shell_command` under `--yolo`: the hook fires, with `permission_mode: "bypass"`,
and gates the call. The approval-bridge design of spec §8 is sound.

**And a deny under `--yolo` really stops the call.** That is the one claim the
whole gate rests on, so it is recorded against the argv the connector actually
builds rather than inferred: `fixtures/cmd/shell-deny-yolo/` is `--yolo` plus
`--tools-enable ask_user_question`, a `cp note.txt copied.txt` the model chose
itself, and a hook that answers deny. The frames carry `tool_hooks` with
`outcome.kind: "block"` and then `tool_hook_blocked`; the recorder diffs the
whole workspace afterwards and `copied.txt` is not in it. `shell-deny/` is kept
beside it as the counter-example — the same deny without `--yolo`, where the CLI
would have refused the call regardless and so proves nothing about our gate.

The reverse is also true and less obvious: **a hook that allows is not enough.**
`fixtures/cmd/shell-allow/` ran without `--yolo`, the hook answered allow, and
print mode refused anyway — `tool_hook_blocked` with "requires permissions. Use
--yolo ... to enable file writes and shell commands in print mode". Hence
`--yolo` on every _ordinary_ turn — and deliberately not on a plan turn, where
no hook fires to replace what it takes away (see 6 above).

The hook payload matches §5.5 exactly. The injected environment has two
variables §5.5 does not list: `COMMANDCODE_SCRATCHPAD` and
`COMMANDCODE_PERMISSION_MODE`.

**And the CLI redacts secrets out of a hook's environment.** A live run with a
logging wrapper showed `OPENADE_HOOK_URL` and `OPENADE_THREAD_ID` arriving, along
with probes named `..._KEY`, `..._PASS` and `..._TICKET` — while
`OPENADE_HOOK_TOKEN`, `..._BEARER`, `..._SECRET`, `..._AUTH`, `..._PASSWORD` and
`..._CREDENTIAL` were all stripped. Our hook script therefore saw a URL and no
bearer, took its "no OpenAde session owns this run" exit — print nothing, exit 0
— and the harness fell back to its own flow, which under `--yolo` allows
everything. **Every tool call ran unapproved, silently.** The safety gate's
failure mode was to open.

Renaming the variable to something the denylist has not learned yet would make
the approval path depend on a heuristic we cannot see. The environment now
carries a _path_, `OPENADE_HOOK_TICKET_FILE`, and the bearer lives in a 0600 file
the session writes when it opens and deletes when it closes.

## Exit codes and endings, as observed

| scenario                | exit | `result.subtype`   | `stopReason`                               |
| ----------------------- | ---- | ------------------ | ------------------------------------------ |
| ordinary turn           | 0    | `success`          | `end_turn`                                 |
| `--max-turns` exhausted | 8    | `max_turns`        | `max_turns`                                |
| SIGINT mid-turn         | 130  | _(no result line)_ | _(no `run_end`)_                           |
| unknown `--model`       | 1    | —                  | fails before the model call, costs nothing |
| no credits (2026-09-15) | 10   | `error`            | `run_error`                                |

SIGINT prints `Interrupted.` on stderr and stops: no `run_end`, no `result`. The
last recording that cannot be made again is `probe-insufficient-credits.ndjson`,
captured before the plan was paid for; it is the only capture of `run_error`.

## Where the transcript really is

`~/.commandcode/projects/<slug>/<sessionId>.jsonl`, and **the slug is not the one
§5.3 describes**. Every recording's manifest says
`transcriptDirMatchesConnectorSlug: false`: the harness kebab-cases camel humps
(`OpenAde` → `open-ade`) and collapses the repeated dash that stripping a leading
slash leaves. Rather than reimplement a private rule, the connector looks the
session up by the one identifier the harness hands it — `run_start.sessionId` is
unique, so the transcript is the `<sessionId>.jsonl` under whichever project
directory holds it.

## Version policy

The connector runs **whatever `cmd` the user has installed, at whatever version
it is**, and never prefers a pinned copy of its own. Nothing is pinned: the npx
fallback asks for `command-code@latest`, and `OLDEST_TESTED_VERSION` (1.54.0) is
only the floor these recordings were made above — below it the probe warns, equal
or above it says nothing, today and for every release after. A version string we
cannot parse does not warn either. There is no update checker and no UI for any
of this.

The probe runs `status --json` and `--list-models` _without_ `--no-auto-update`,
which is how the global install upgraded itself from 1.54.0 to 1.55.1 while an
agent was asking its version. That is the wanted behaviour — a probe is the one
safe moment to let the CLI update itself. Turn spawns keep `--no-auto-update`,
because swapping the binary under a running conversation is not.

## Running the app

Against the real CLI. There is no stand-in binary any more: the invented
`fake-cmd.mjs` was written when the account had no credits, and it is gone along
with the reconstructed model table and the hand-written frame fixtures. Point a
connector instance at your own `cmd` (or leave the binary path empty and let the
probe find it) and send a message.

Tests replay recordings through `packages/testkit/bin/replay-cmd.mjs`, which has
no behaviour of its own. The conformance suite also runs against the real CLI,
opt-in:

```sh
OPENADE_LIVE_CMD=1 pnpm vitest run apps/server/src/hooks/cmdLiveConformance.test.ts
```

It spends the operator's plan, so it is skipped otherwise, and it refuses to run
on any model but the three the operator authorised
(`meta/muse-spark-1.3-contributor`, `poolside/laguna-s-2.1-free`,
`inclusionai/ling-3.0-flash-sante:free`).

So does the end-to-end suite, which drives the whole assembled product — server,
socket, client fold — against the same binary:

```sh
OPENADE_LIVE_CMD=1 pnpm vitest run apps/server/test/e2e
```

Without the variable the same scenarios run against the recordings, which is
what the gate does. See `apps/server/test/e2e/harness.ts` for what the two
drivers differ in, which is only the binary.

## What an interrupted run leaves behind

**Nothing.** A run killed by SIGINT never writes its transcript, so the session
id it announced at `run_start` names a session that no longer exists anywhere:

```
Error: --session "<id>" is neither an existing .jsonl transcript nor a known session-id prefix.
```

and the next spawn exits 1 before emitting a frame
(`fixtures/cmd/interrupt-resume/`, turn 2). Pressing Stop therefore used to
break a thread permanently — every turn after it failed the same way. The
connector now checks the filesystem for a transcript before it resumes, which is
the same question the harness asks, and continues in a new session with a
`session.warning` when there is none (`fixtures/cmd/interrupt-continue/`).

## Two connector decisions worth writing down

1. **The `openade` MCP entry goes in the local scope (§5.3) rather than
   `<projectRoot>/.mcp.json`.** Both are real local scopes, but the second lives
   inside the user's git repo and would be committed with a dead loopback URL in
   it. Section 8 step 2 names the first one; we follow it.

   **The CLI writes that file, not us** — `cmd mcp add-json --scope local`, and
   `cmd mcp remove` to take it back. The file is
   `~/.commandcode/projects/<slug>/mcp.json`, and the slug is the same private
   rule the transcript locator refuses to reimplement. Writing it ourselves put
   the entry beside the directory the harness reads whenever the workspace path
   has a camel hump or an underscore in it — `…/mcpslug.suYi/wsCamelCase` is
   filed under `…-mcpslug-su-yi-ws-camel-case`, our guess said
   `…-mcpslug.suyi-wscamelcase` — and `/Volumes/main/Code/OpenAde` is one of
   those paths (`open-ade`, not `openade`). For a plain lowercase path like
   `/Volumes/main/Code/admiro` the guess happened to be right, which is why this
   went unnoticed: it worked for some projects and silently offered the model no
   browser tools at all in others. `cmd mcp add-json` writes byte-identical
   content, placeholder and all, and it is what `record-cmd.mjs` had always used
   to register its own server.

2. **Both files we write into a user's project are reverted when the session
   closes** — the PreToolUse block and the MCP entry. The hook block is reverted
   only while the file still hashes to what we wrote, and only once the last
   session using that project has closed; a file edited since is left alone. The
   MCP entry is removed by name through the CLI, so a server the user added
   under any other name is untouched.

   The session that has to close for any of that to happen is now closed by the
   `SessionManager` when the server stops. Its driver scopes are free-standing,
   and nothing used to close the ones still open at shutdown, so the finalizers
   never ran: every server exit left the hook block and an `openade` entry
   naming a dead port behind, one per session, in files the user owns.
