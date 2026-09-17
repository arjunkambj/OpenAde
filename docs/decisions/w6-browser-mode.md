# W6 · Browser mode decision (2026-09-17)

Spec section 12 lists two modes and marks A preferred. The day-one spike ran
against the real `agent-browser` 0.38.1 binary installed on this machine
(Chrome for Testing 153 already downloaded); the questions that decided the
mode were verified live, not from the README alone.

## Decision

**Mode A — CDP attach to the in-app `<webview>` — is the primary mode.**
Mode B — agent-browser's own Chromium plus its `stream` WebSocket — is the
fallback the server picks automatically when mode A cannot run: no CDP port
(the renderer is a plain web client or `OPENADE_REMOTE_DEBUG=0`), or no
webview target shows up inside the attach grace window. `BrowserState.mode`
already carries both literals and `frame` is nullable for exactly this split.

Both modes drive the same way: the MCP `browser_*` tools shell out to
`agent-browser --session ade-<threadId> --json <cmd>` through a per-thread
serialized queue. We wrap the CLI rather than injecting `agent-browser mcp`
(spec §12): that is what gives us per-thread sessions, target pinning, the
interrupt rule, and teardown on thread close.

## What the spike verified

- `agent-browser --json` envelope: `{success, data, error}` on every command;
  `data` carries `url`/`title` on navigation, `refs` + `snapshot` text on
  `snapshot -i`, `port` on `stream status`.
- `snapshot -i` returns ref-keyed accessibility nodes (`@e1`, `@e2`, …);
  `click @e2`, `fill`, `eval`, `back`, `wait --load`, `screenshot <path>` all
  work against a daemon session.
- **Mode A attach chain, run live against a real Chrome CDP endpoint:**
  `agent-browser --cdp <port> --session S tab --json` lists targets with
  `targetId`/`type`/`url`; `--pin-tab tab <targetId>` binds the session;
  subsequent `snapshot -i` / `get url` drive exactly that target. The binding
  survives across CLI invocations because the daemon persists it by CDP
  targetId. agent-browser's own `skill-data/electron/SKILL.md` documents
  Electron `<webview>` guests appearing as `type: "webview"` targets that
  drive like pages (webview support landed in v0.17.1), so the same chain
  binds the pane's guest.
- **Mode B stream, run live:** every session auto-starts a stream server;
  `stream status --json` reports the bound port. `ws://127.0.0.1:<port>`
  emits `status`/`tabs` then `frame` messages (base64 JPEG +
  `{deviceWidth, deviceHeight}` metadata) as the page paints, `url` messages
  on navigation, and accepts `input_mouse` / `input_keyboard` events plus a
  `config {maxFps}` throttle. Frames are latest-first — nothing stale queues.
- `close` on the session tears down the browser; a next command would relaunch
  a fresh daemon, so teardown must run exactly once at thread end.

## How mode A finds the right webview

The pane loads a marker page served by our own HTTP server,
`GET /browser/attach/<threadId>` (inert, styled, unauthenticated — the webview
cannot set headers). The driver lists `--cdp <port> tab --json` targets and
binds the first `webview`/`page` target whose URL starts with the marker
prefix; with exactly one candidate target it binds that regardless of URL
(the marker has already been navigated away from on a re-bind). Desktop main
enables `remote-debugging` on a random loopback port and hands it to the
server as `OPENADE_CDP_PORT`.

## Human control and `interrupted_by_human`

- Mode A: the guest is a real browser view — human input lands in the page
  directly. Desktop main hooks `before-input-event` / `before-mouse-event` on
  the guest webContents (resolved via its `persist:thread-*` partition) and
  relays them to the renderer, which calls `browser.humanInput`. The server
  keeps a per-thread epoch; a call that ends under a different epoch than it
  started returns `interrupted_by_human` instead of its result.
- Agent-caused input must not bump the epoch: while a `browser_*` call is
  in-flight, input classes that call can produce (click→pointer, type/fill/
  press→key, scroll→wheel) are consumed by a lease instead. A human click
  during `browser_wait`/`browser_snapshot` (no input lease) interrupts. A
  human click landing in the same instant as the agent's own click can be
  absorbed by the lease — the next human input still interrupts. Acceptable
  and documented rather than perfect.
- Mode B: every pane input is human by construction (the agent cannot click
  our `<img>`), so it always bumps the epoch and is then forwarded to the
  stream WS.
- `browser.humanInput` also carries `location` (passive did-navigate sync —
  no bump, no driver action) and `history` (back/forward/reload — bumps;
  drives `back`/`forward`/`reload` in mode B, the webview itself in mode A).

## What is deliberately not done

- **Timeline items**: the MCP server only executes and returns. The harness
  calls the tools as `mcp__openade__browser_*`, so the rows in the timeline
  come from Command Code's transcript through W2's translator (kind
  `mcp_tool_call`), not from a second emission here — server-side emission
  would double every row. The pane's "agent is driving" indicator reads
  `BrowserState.activeTool` instead.
- `agent-browser mcp` stays a possible fallback behind a setting, per spec.
- WebMCP is P1 (spec §12).
- Live verification covers real Chromium on this machine; the Electron
  `webview` target path is verified by agent-browser's documented contract,
  not by a running OpenAde desktop session (the pane ships with this change
  and the dock does not exist until W4).
