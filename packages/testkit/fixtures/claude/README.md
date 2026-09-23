# Claude Code recordings

**Every directory here is a real recording of the real Claude Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|             |                                                                   |
| ----------- | ----------------------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/claude` (the operator's global install)        |
| Version     | **2.1.280**                                                       |
| SDK         | `@anthropic-ai/claude-agent-sdk` **0.3.280**                      |
| Recorded on | **2026-09-23**                                                    |
| Model       | the CLI's `default`                                               |
| Recorded by | `packages/connector-claude/test/record*.test.ts`, through the tee |

The transport is `sdk-stream` (docs/development.md, "The recording format"):
the testkit's stdio tee sat where the connector's binary path points, so each
`invocation-<n>.ndjson` is what the real SDK and the real CLI said to each
other, line by line, and the manifest lists every launch with its argv and exit.

| Scenario     | What it is                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `probe`      | The connector's probe: `--version`, `auth status --json`, and the zero-turn SDK handshake. Signed out. |
| `signed-out` | One session and one turn against a CLI that is not signed in: the CLI refuses without calling the API. |

Both were recorded while the CLI on the recording machine was signed out, so
neither spent anything. Scenarios that run the model are recorded signed in.
