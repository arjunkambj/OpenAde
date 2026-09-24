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

Each scenario is a `manifest.json` (the tabs the thread had before the CLI
connected, and each CLI command with its `--json` envelope) and
`frames.jsonl`, every CDP message on the bridge connection in arrival order.
`from-harness` is the CLI; `to-harness` is the bridge. A step that is
`{host: "remove", index}` instead of a command is the pane closing that tab.

The bridge's tests replay the frames (`transport: "cdp-websocket"`). The
`cli-*` scenarios are the server's in-app driver's own command sequences, and
its tests replay their envelopes (`transport: "cli-json"`).

| Scenario                    | What the CLI did                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `connect-and-drive`         | attach to the one tab; title, snapshot, fill, click, type, press, scroll, screenshot, eval, navigate |
| `empty-thread-createTarget` | connect to a thread with no tab: `createTarget(about:blank)`, then open the site                     |
| `tab-new-close`             | open a second tab, read it, close it                                                                 |
| `popup`                     | `window.open` from the page arrives as a second tab; switch between them                             |
| `reload`                    | reload: the bridge reloads the guest instead of forwarding `Page.reload`                             |
| `cli-attach`                | the server's attach (list, pin the first tab, stream off), a call, the daemon stopping, re-attach    |
| `cli-empty-thread`          | the first call on a thread with no tab: connecting creates one, which is then pinned                 |
| `cli-tabs-pinned`           | `tab new` and `tab <id>` move the pin; closing the bound tab leaves the session to attach again      |
| `cli-tab-gone`              | the pane closes the pinned tab: the next command fails `tab_gone`, then the next tab is pinned       |
| `cli-last-tab-gone`         | the pane closes the only tab: `tab_gone`, an empty list, `tab new`, pin                              |

Scrubbed on the way in: the site and bridge ports (`<SITE_PORT>`,
`<BRIDGE_PORT>`), the launch key and every capability (`<REDACTED>`), the
daemon's stream port (`<STREAM_PORT>`), the
scratch and home directories, and a screenshot's image bytes (kept as their
length). Target and session ids are per-run and stay as recorded.
