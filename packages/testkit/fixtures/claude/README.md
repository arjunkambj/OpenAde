# Claude Code recordings

**Every directory here is a real recording of the real Claude Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/claude` (the operator's global install) |
| Version     | **2.1.280**                                                |
| SDK         | `@anthropic-ai/claude-agent-sdk` **0.3.280**               |
| Recorded on | **2026-09-23**                                             |
| Model       | the CLI's `default` (each manifest names what it ran as)   |

The transport is `sdk-stream` (docs/development.md, "The recording format"):
the testkit's stdio tee sat where the connector's binary path points, so each
`invocation-<n>.ndjson` is what the real SDK and the real CLI said to each
other, line by line, and the manifest lists every launch with its argv and exit.
The scrubber replaced the account, the home directory, the scratch root, the MCP
bearer and the operator's own skills, commands and agents.

## Scenarios

| Scenario          | Recorded by                                            | What it is                                                                                                                                                 |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`           | `packages/connector-claude/test/recordProbe.test.ts`   | The connector's probe: `--version`, `auth status --json`, and the zero-turn SDK handshake that lists the models. Signed out.                               |
| `signed-out`      | `packages/connector-claude/test/recordSession.test.ts` | One session and one turn against a CLI that is not signed in: the CLI refuses without calling the API.                                                     |
| `conformance`     | `packages/connector-claude/src/conformance.test.ts`    | The connector conformance suite, one session launch per case in the suite's order. Signed out: each turn is refused the same way.                          |
| `signed-out-turn` | `apps/server/test/e2e-claude/signed-out.test.ts`       | One turn through the real server against a signed-out CLI: two probes (boot and the connectors page's refresh), then the session, refused without the API. |

Everything above was recorded while the CLI on the recording machine was signed
out, so none of it spent anything.

## Waiting for a signed-in CLI

These scenarios have their tests and recorders in place, and are skipped under
replay — the skip says so in its title — until they are recorded:

| Scenario                | Test                                            | What it will show                                                                                                   |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `plain-reply`           | `apps/server/test/e2e-claude/turn.test.ts`      | One answered turn: streamed text, usage, `end_turn`. Also replayed by `recordedSession.test.ts`.                    |
| `interrupt`             | `apps/server/test/e2e-claude/interrupt.test.ts` | A turn interrupted after its first text, then a follow-up: whether the same process serves the next.                |
| `resume`                | `apps/server/test/e2e-claude/resume.test.ts`    | Two turns with the server restarted between: the second session launch is `--resume`.                               |
| `edit-approval`         | `apps/server/test/e2e-claude/approval.test.ts`  | Approval-required: a write to `hello.txt` asked about, allowed once, written after. Also `recordedSession.test.ts`. |
| `deny`                  | `apps/server/test/e2e-claude/approval.test.ts`  | Approval-required: `touch denied.txt` denied at every card; the file is absent. Also `recordedSession.test.ts`.     |
| `sensitive-full-access` | `apps/server/test/e2e-claude/approval.test.ts`  | Full access (`bypassPermissions`): `cat .env` still opens a card, which is denied. Also `recordedSession.test.ts`.  |

Record them, once `claude auth status` says `loggedIn: true` in the operator's
own shell, with:

    OPENADE_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts test/e2e-claude/interrupt.test.ts test/e2e-claude/resume.test.ts test/e2e-claude/approval.test.ts

and re-record `conformance` signed in the same way from its own file, so the
suite's turns are answered ones. That recording also takes the suite's
approval case (a file write stopped on a card and allowed once), which the
replay runs only once the recording has it.
