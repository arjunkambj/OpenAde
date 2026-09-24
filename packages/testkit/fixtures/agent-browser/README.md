# agent-browser recordings

**Every directory here is a real recording of the real agent-browser CLI
driving real Electron webviews through the desktop's browser bridge.** Nothing
in it is hand-written. When agent-browser or Electron changes, these are
re-recorded — never edited to make a test pass.

|             |                                                     |
| ----------- | --------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/agent-browser` (global install)  |
| Version     | **0.38.1**                                          |
| Electron    | **44.3.0**                                          |
| Recorded by | `packages/testkit/scripts/record-agent-browser.mjs` |

Each scenario is a `manifest.json` (`transport: "cdp-websocket"`, the tabs the
thread had before the CLI connected, and each CLI command with its `--json`
envelope) and `frames.jsonl`, every CDP message on the bridge connection in
arrival order. `from-harness` is the CLI; `to-harness` is the bridge.

| Scenario                    | What the CLI did                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `connect-and-drive`         | attach to the one tab; title, snapshot, fill, click, type, press, scroll, screenshot, eval, navigate |
| `empty-thread-createTarget` | connect to a thread with no tab: `createTarget(about:blank)`, then open the site                     |
| `tab-new-close`             | open a second tab, read it, close it                                                                 |
| `popup`                     | `window.open` from the page arrives as a second tab; switch between them                             |
| `reload`                    | reload: the bridge reloads the guest instead of forwarding `Page.reload`                             |

Scrubbed on the way in: the site and bridge ports (`<SITE_PORT>`,
`<BRIDGE_PORT>`), the launch key and every capability (`<REDACTED>`), the
scratch and home directories, and a screenshot's image bytes (kept as their
length). Target and session ids are per-run and stay as recorded.
