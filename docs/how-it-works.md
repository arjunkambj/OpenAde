# How it works

OpenAde is an Electron desktop app that drives the Command Code CLI — an
agentic coding harness that normally runs in a terminal — from a graphical
interface. This document traces what actually happens at runtime, in order,
with the real names of the processes, commands, events, RPC methods and files
involved, and a path into the source for each step.
[architecture.md](architecture.md) describes the pieces themselves,
[philosophy.md](philosophy.md) the rules they keep,
[development.md](development.md) how to run them, and
[command-code-connector.md](command-code-connector.md) and
[claude-code-connector.md](claude-code-connector.md) what the CLI on the far
end does.

Three processes matter.

```
┌─────────────────────────────┐
│ Electron main               │  apps/desktop/src/main
│  ServerSupervisor ──────────┼──spawn──┐
│  window + preload bridge    │         │
└──────────┬──────────────────┘         │
           │ IPC                        ▼
┌──────────┴──────────────────┐  ┌──────────────────────────────┐
│ Renderer (React)            │  │ Server (Effect, node)        │
│  apps/web                   │◄─┤  apps/server                 │
│  atoms, timeline, composer  │ws│  event store, decider,       │
└─────────────────────────────┘  │  reactors, permissions,      │
                                 │  hook bridge, MCP gateway    │
                                 └──────────┬───────────────────┘
                                            │ spawn, one per turn
                                            ▼
                                 ┌──────────────────────────────┐
                                 │ cmd (the user's own install) │
                                 │  print mode, NDJSON on stdout│
                                 └──────────────────────────────┘
```

The server starts two other kinds of child besides `cmd`: `agent-browser` for
the browser pane (§10), and a login shell per open terminal (§11).

The renderer never touches the filesystem, git or a child process: everything
it knows arrives over one authenticated WebSocket. The server is the single
writer of durable state, and it is event-sourced — a client dispatches a
`Command` and reads the events that come back. The connector is the only part
that knows what a Command Code CLI is; everything above it is written against
the connector-neutral `RuntimeEvent` vocabulary in
`packages/contracts/src/runtime.ts`.

---

## 1. Boot

### The supervisor spawns the server

`apps/desktop/src/main/index.ts` takes the single-instance lock, registers the
app's own `openade://` scheme as privileged, and constructs a `ServerSupervisor`
(`apps/desktop/src/backend/ServerSupervisor.ts`) before the first window
opens.

What is spawned comes from `apps/desktop/src/backend/serverArgs.ts`:

| build    | command            | argv                                            |
| -------- | ------------------ | ----------------------------------------------- |
| packaged | `process.execPath` | `out/server/main.cjs` (asar-unpacked)           |
| from src | `process.execPath` | `--import <tsx loader> apps/server/src/main.ts` |

Both run under `ELECTRON_RUN_AS_NODE=1`. The dev form uses `--import` rather
than the `tsx` CLI deliberately: the CLI re-execs node as its own child, and
the grandchild does not inherit the supervisor's fd 3, so the handshake never
arrives (`serverArgs.ts` documents the failure in full).
`apps/desktop/src/backend/serverDeps.ts` adds the environment — `OPENADE_DEV`,
and `OPENADE_CDP_PORT` when remote debugging is on, which is what later decides
the browser pane's mode.

The child is spawned with `stdio: ["ignore", "inherit", "inherit", "pipe"]`.
Stdout and stderr are the server's log; **fd 3 carries the handshake**.

### The server assembles itself

`apps/server/src/main.ts` is argument parsing and a runtime call; the graph is
`apps/server/src/boot.ts`, which builds, in one `Layer.build`:

- SQLite (`persistence/Sqlite.ts`) and the migrations
  (`persistence/Migrations.ts`), so every table exists before the first read;
- the event store and read models (`persistence/EventStore.ts`,
  `persistence/ReadModels.ts`);
- the orchestration engine (`orchestration/Engine.ts`), the session manager
  and the reactors (`ProviderCommandReactor`, `CheckpointReactor`,
  `AttachmentReactor`, `makeSessionSupervisor`);
- the connector registry, seeded with the Command Code and Claude Code
  definitions in that order (`packages/connector-cmd/src/definition.ts`,
  `packages/connector-claude/src/definition.ts`), and the `ConnectorManager`
  that reconciles it against the settings document;
- permissions, git/files, attachments, the browser service and the MCP
  gateway;
- the HTTP server on `127.0.0.1` with port `0` (the OS picks), and the
  WebSocket route.

`boot` sets `OPENADE_HOME` for the whole process before anything resolves a
path, which is why every directory in this document hangs off `~/.openade` by
default (`packages/shared/src/paths.ts`).

Two things happen after the graph is built and before the handshake:
`connectorHost.install(...)` fills in the endpoints only a running server can
supply (the per-thread MCP endpoint, the hook endpoint and handler registry,
and the permission ladder), and `ConnectorManager.ready` is awaited so no
client is admitted while connector routing would still answer `NoConnector`.
Probes keep running behind the handshake.

### The handshake

`apps/server/src/rpc/bootstrap.ts` writes one JSON line:

```json
{ "url": "ws://127.0.0.1:52431/ws", "token": "<uuidv7>", "serverInstanceId": "<uuidv7>" }
```

to fd 3 when one exists, and to stdout otherwise (a process with an IPC channel
— a test runner's worker — is never a desktop spawn, so it takes the stdout
path). In dev it also writes `~/.openade/dev/connection.json`, created `0700`
and written `0600`, then `chmod`ed again because `writeFileSync` does not lower
an existing file's mode. That file holds a bearer for a socket that accepts
`orchestration.dispatch`, so its permissions are not cosmetic.

The token and the `serverInstanceId` are minted fresh on every boot.

### Backoff and restart

The supervisor's state is `starting | ready | restarting | failed`. The
constants in `ServerSupervisor.ts`:

| constant                   | value  | what it bounds                              |
| -------------------------- | ------ | ------------------------------------------- |
| `INITIAL_BACKOFF_MS`       | 500    | first restart delay, doubling               |
| `MAX_BACKOFF_MS`           | 10 000 | the ceiling                                 |
| `MAX_CONSECUTIVE_FAILURES` | 5      | then `failed`, and the crash dialog         |
| `HANDSHAKE_TIMEOUT_MS`     | 15 000 | a child that never writes fd 3 is SIGKILLed |
| `KILL_GRACE_MS`            | 5 000  | SIGINT, then SIGKILL                        |
| `MAX_HANDSHAKE_BYTES`      | 65 536 | bytes without a newline before giving up    |

A malformed handshake takes the same failure path as a crash: the child is
killed and the backoff schedules another attempt. A successful handshake resets
the failure count and the backoff. After five consecutive failures the
supervisor stops and `showServerCrashDialog` reports the reason rather than
spinning.

Every transition is pushed to the renderer through the preload bridge
(`apps/desktop/src/main/serverStateBridge.ts`,
`apps/desktop/src/preload/bridge.ts`), which is how a renderer reconnects to a
restarted server without reloading the window.

### The dev loop

`pnpm dev` runs `apps/desktop/scripts/dev.mjs` alongside Vite. The script
esbuild-watches the main/preload bundles and restarts Electron on a successful
rebuild; Electron restarts the supervised server. The renderer is served by
Vite on port 3001, and `apps/web/vite.config.ts` mounts one extra middleware,
`GET /__openade/connection`, which serves the dev connection file. That route
refuses a cross-origin read — the body is a bearer token — and 404s when no dev
server is running.

---

## 2. Connect

### Finding the server

`packages/client-runtime/src/resolver.ts` asks each channel in order:

1. `window.openade.getServerState()` — the supervisor's live view, including a
   restarted server's new port, token and boot id;
2. `window.openade.getConnection()` — the older preload getter;
3. `GET /__openade/connection` — the dev Vite plugin;
4. `?server=<url>&token=<t>` search params.

`null` from all of them means "no channel configured", and the UI shows its
connect screen.

### The socket supervisor

`packages/client-runtime/src/connection.ts` builds the `Connection` service
every atom shares. Effect's socket protocol is single-use, so reconnecting
means rebuilding the socket, the protocol and the `RpcClient` underneath
callers; `Connection.client` is a per-call accessor that resolves to whichever
client is currently live and waits through a reconnect.

Credentials are re-read on **every** attempt, not captured once, because a
restarted server binds a different port and mints a different token. An attempt
with nothing to dial fails with `no-credentials` and is retried on the same
backoff as a refused socket — which is the state the desktop renderer boots in
while the supervisor is still starting the server.

The token travels on the upgrade query (`ws://host/ws?token=…`) because the
browser WebSocket API cannot set headers. `apps/server/src/rpc/server.ts`
compares it with `timingSafeEqual` and answers `401` before the RPC protocol
ever runs.

Backoff is 100 ms doubling to a 2 s ceiling. An attempt is only an epoch once
the protocol's own `onConnect` hook has fired: building the protocol does not
dial, and an attempt that "succeeded" against a dead port used to report
`connected` over a socket that could not carry a request.

Status is one of `connecting | connected | reconnecting | disconnected |
incompatible`. `incompatible` is absorbing — see below.

### Hello, subscribe, resume

Every subscription in `packages/client-runtime/src/atoms.ts` is a
`hello → subscribe` loop:

```
client["server.hello"]({})
  → { protocolVersion, serverInstanceId }
  │
  ├─ protocolVersion ≠ PROTOCOL_VERSION (3) → markIncompatible, Stream.never
  │
  ├─ serverInstanceId changed → drop the cached snapshot, afterSequence = undefined
  └─ otherwise                → afterSequence = doc.snapshotSequence
  │
  └─ client["threads.subscribe"]({ threadId, afterSequence })
       snapshot | event… → "synchronized" → live events
```

`retainedInstanceId` in `connection.ts` is the rule that keeps a plain socket
drop from looking like a server restart: the boot id is cleared only when a
channel reports a _different_ one. A status change does not touch it.

The server side is `OrchestrationEngine.subscribeThread`
(`apps/server/src/orchestration/Engine.ts`): it subscribes to the events PubSub
_before_ reading the baseline so nothing commits in the gap, emits either a
snapshot or the replay after `afterSequence`, then `{ kind: "synchronized" }`,
then live events through a `LiveBuffer`. The buffer coalesces on
`STREAM_COALESCE_MS` (50 ms) and enforces the budgets in
`packages/contracts/src/rpc.ts`:

| budget                | value |
| --------------------- | ----- |
| `STREAM_BUDGET_ITEMS` | 1000  |
| `STREAM_BUDGET_BYTES` | 8 MiB |

A subscription that exceeds either ends with `{ kind: "resnapshot-required" }`
rather than growing a backlog. The client drops its cached document and
resubscribes from scratch — `Stream.retry` covers a failed attempt,
`Stream.repeat` covers the clean end the server sends after a resnapshot.

Read models with no subscription (`projects.list`, `connectors.list`,
`keybindings.get`) are refetched once per connected epoch through
`perConnection`, because the socket carries no invalidation.

---

## 3. First run

A fresh install has no projects, so `/` shows "No projects yet" and the same
Add project dialog the sidebar opens
(`apps/web/src/components/sidebar/add-project-dialog.tsx`). Connectors are
checked in Settings → Connectors.

### The probe

`ConnectorManager` (`apps/server/src/settings/ConnectorManager.ts`) seeds one
enabled instance per registered definition on a fresh install, in the
registry's order, then probes each. Command Code is registered first, so a
thread that names no instance still routes to it. For Command Code,
`packages/connector-cmd/src/probe.ts` does the work:

1. resolve the binary (`packages/connector-cmd/src/binary.ts`): the configured
   `binaryPath`, then `cmd` on `PATH` plus the global bin directories a GUI
   process never inherits (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.bun/bin`,
   `~/.local/share/pnpm`, `~/.npm-global/bin`), then `npx -y
command-code@latest`. Nothing resolvable at all reports `not-installed`.
2. run `status --json` (30 s timeout);
3. run `--list-models` (60 s timeout) and parse the two-column table into
   `ModelOption`s, with the section headers as `family`.

Both probe calls deliberately omit `--no-auto-update`: a probe is the one safe
moment to let the CLI upgrade itself. Turn spawns keep it, because swapping the
binary under a running conversation is not safe.

The probe's children get the same environment allowlist a turn's do, so an
operator's `COMMAND_CODE_API_KEY` set through `extraEnv` is not reported as
"not authenticated" while turns work fine.

Every probe that found a binary reports `installed: true`; a signed-out one
also carries `loginCommand`, which is what the renderer shows the user to run.
It is spelled against the binary the probe resolved — `/opt/homebrew/bin/cmd
login` for a found `cmd`, `npx -y command-code@latest login` for the npx
fallback — so a machine without a `cmd` on PATH is never told to run one. The
wire probe adds `authenticated`, derived from `auth`.

Exit codes decide the status (`packages/connector-cmd/src/exitCodes.ts`):

| exit   | probe status             | what the user is told                                        |
| ------ | ------------------------ | ------------------------------------------------------------ |
| 0      | `ready`                  | binary path, version, account, model count                   |
| 3      | `not-authenticated`      | not logged in — run the `loginCommand`                       |
| 10     | `error`, `auth: present` | insufficient credits, with `helpUrl` to the billing page     |
| 1, 4–9 | `error`                  | the sentence from `EXIT_MESSAGES`, plus the harness's detail |

The billing link (`CMD_ACCOUNT_HELP_URL`) and the docs link
(`metadata.docsUrl`, `https://commandcode.ai/docs`) live in
`packages/connector-cmd`, so no connector's domain name is written into the
renderer: it receives the first as `ConnectorProbe.helpUrl` and the second over
`connectors.describe`. `apps/web/src/components/Settings/probe-help.ts` decides
which failures get a link at all — the probe's own `helpUrl`, or else the
connector's docs link for an account-shaped failure.

The Claude Code probe (`packages/connector-claude/src/probe.ts`) resolves
`claude` the same way — the configured `binaryPath`, then `PATH`, then the
directories its installers use (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.claude/local`, and the npm, pnpm and bun global bins) —
with no runner to fall back on, and asks three questions under the
environment a session gets:

1. `claude --version`, which prints `2.1.280 (Claude Code)`. Below
   `OLDEST_TESTED_VERSION`, the release the recordings were made at, the probe
   warns; it never refuses a version.
2. `claude auth status --json`: `loggedIn` true is `auth: present`, false is
   `absent` and the status `not-authenticated`. The CLI exits 1 when signed out
   and still prints the document, so the output is read whatever the exit
   code. `loginCommand` is `claude auth login` spelled against the resolved
   binary, prefixed with `CLAUDE_CONFIG_DIR=…` when the instance has an account
   directory of its own.
3. The model list, which only the SDK handshake carries: a `query()` whose
   prompt never yields starts the CLI, reads the initialize response's
   `models` — the CLI's own rows, `default` first, each with its effort levels
   — and stops the CLI's process group again. No message is sent, so nothing
   reaches the API. An instance keeps its list, so the model picker does not
   start a CLI each time it opens.

`fixtures/claude/probe/` is that probe recorded, signed out.

`apps/web/src/lib/connector-health.ts` reads a `ConnectorSummary` into one of
five states — `ready`, `probing`, `not-installed`, `signed-out`, `error` — plus
the command that fixes it and a sentence built from the instance's display
name. Signed-out is decided before ready: a harness that answers `ready` with
`auth: "absent"` (or `authenticated: false`) is installed and reachable but
cannot run a turn. The command is the probe's `installCommand` for
not-installed and its `loginCommand` for signed-out, and null when the
connector named none; the renderer never spells a command of its own.

Two surfaces show it. Each Settings → Connectors card has a status badge beside
the instance's name and a line under it with the binary, version, account,
model count, the probe's message and the fixing command in a copyable code span
(`apps/web/src/components/Settings/connector-status.tsx`). Above the composer —
on an open thread and on the start screen — `harness-health-banner.tsx` shows an
alert when the thread's instance (`threadConnectorInstanceId`: the bound one,
else the chosen one, else the routing fallback) is neither ready nor still
probing: "Command Code is not signed in", then "Run `<loginCommand>` in a
terminal, then check again", with a Check again button that re-probes every
connector.
The banner is rendered by `thread-view.tsx` and `start-thread.tsx`, outside the
composer itself.

A version below `OLDEST_TESTED_VERSION` (1.54.0) produces a warning and nothing
else. Nothing is pinned: the connector runs whatever `cmd` the user has.

### Choosing a folder

The desktop has a native dialog (`window.openade.pickDirectory`). Everywhere
else — a browser tab, and later a client that is not on this machine — gets
`apps/web/src/components/folder-picker/`, which browses the **server's** disk
through `fs.browse`.

`apps/server/src/fs/Directories.ts` lists one directory's subfolders, sorted,
hidden entries left out unless they were asked for, each flagged when it holds a
`.git`. The rules: absolute paths only (a relative one would resolve against the
server's working directory), the answer names the symlink-resolved path it
actually read — so a breadcrumb is a path `fs.browse` accepts back — a symlinked
entry is listed but never badged as a git repository, because deciding that
means reading inside the link target, an unreadable entry is skipped rather than
failing the listing, and the list truncates at `FS_BROWSE_ENTRY_LIMIT` (500)
with a `truncated` flag. Failures come back as
`FsBrowseError` with one of `not-absolute | not-found | not-a-directory |
permission-denied | internal` — five named reasons, because the picker offers a
different next step for each.

The picker's logic is values in
`apps/web/src/components/folder-picker/picker-state.ts`: the browsed path and
the typed text are separate, and paths come back from the server rather than
being computed client-side.

### Creating the project

`project.create` carries `{ projectId, name, workspaceRoot }` — the id is
minted by the caller, which is what makes a retry idempotent. The decider
(`apps/server/src/orchestration/decider.ts`) rejects a duplicate id and a
workspace root another project already owns. The Add project dialog keeps a
rejected path in the field so it can be corrected.

---

## 4. A turn, end to end

### The composer

`apps/web/src/components/composer/` owns the draft. What Enter means is a pure
function in `composer-keys.ts`:

- an IME mid-composition → **insert**: the Enter commits the composition, even
  while a menu has rows;
- a `/`, `#`, `@` or `$` menu that has rows → **pick** the highlighted one;
- Mod, Ctrl or Alt held → **keymap**, leaving the chord to the keybinding
  listener;
- Shift held → **insert** a newline;
- otherwise → **send**.

What a send then does is `sendMode` in `send-mode.ts`:

| The thread                               | Enter or the send button                     | `Mod+Enter`                                                   |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| idle                                     | `thread.turn.start` — a new turn             | `thread.turn.start { queued: true }`, which starts a turn too |
| a turn running, the harness cannot steer | `thread.turn.start { queued: true }` — queue | the same                                                      |
| a turn running, the harness steers       | `thread.turn.steer` — into the running turn  | `thread.turn.start { queued: true }` — queue                  |

`Mod+Enter` is the `composer.queue` binding, and it always queues, so a
follow-up meant for after the turn still waits for it on a harness that steers.
Whether the harness steers is the `steering` capability of the instance the
thread runs on (`instanceCapabilities`, the same read the attach button uses).

Plain Enter and Shift+Enter are fixed. Any other Enter chord belongs to the
keymap, so `composer.queue` (`Mod+Enter` by default) is an ordinary table row
and rebinding it changes the key in the composer too. With the focus in the
composer's textarea it sends with `queued: true`; anywhere else it puts the
focus back in the composer. On the start screen it sends, since a thread that
does not exist yet has nothing to queue behind.

The composer and the start screen answer the same keys
(`use-composer-commands.ts`): `Mod+L` focuses the textarea, `Mod+U` opens the
file chooser the attach button opens (or, when the connector refuses
attachments, shows the button's sentence and opens nothing), and
`Mod+Shift+Backspace` in the composer clears the text, the mentions and the
attachments, as `/clear-draft` does. The settings row under the input
(`thread-settings-keys.tsx`) answers the rest through the same `onChange` a
click uses:

| key                           | does                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `Shift+Tab` (in the composer) | toggle plan mode (§6)                                                                   |
| `Mod+Shift+L`                 | next runtime mode the connector offers, in contract order, wrapping (`nextRuntimeMode`) |
| `Mod+Shift+M` / `Mod+Shift+E` | open the model / effort picker                                                          |
| `Mod+Shift+.` / `Mod+Shift+,` | one rung up / down the model's effort ladder, stopping at either end (`stepEffort`)     |

A picker the connector locks until restart does not open, and a locked effort
does not step. The plan button's tooltip and the attach button's show their
current keys.
`use-send-draft.ts` uploads any attachments first (a browser `File` has no
filesystem path, so the server must hold the bytes before the command can name
them) and latches so one Enter cannot start two real turns. While a turn is in
flight a Stop button appears and the send button becomes Queue — or, when the
harness steers, "Steer turn", whose tooltip names both keys, with "Steering the
running turn" in muted text beside the context gauge. All of it reads
`turnInFlight` (`apps/web/src/lib/turn.ts`) rather than `currentTurnId`, which
the projection only fills one event later.

Four characters open a menu, each only at the start of the text or after
whitespace (`detectComposerTrigger` in
`packages/client-runtime/src/composerTrigger.ts`), and each closes at the next
whitespace:

| Trigger | Lists                                                | A pick writes                       | The turn carries it as |
| ------- | ---------------------------------------------------- | ----------------------------------- | ---------------------- |
| `/`     | commands, then the instance's skills                 | the command, or `/name ` as text    | text                   |
| `#`     | the project's files                                  | `#path ` and a chip                 | `mentions`             |
| `@`     | the instance's plugins, then its skills, never files | `@plugin ` or `$skill `, and a chip | `references`           |
| `$`     | the instance's skills alone                          | `$skill ` and a chip                | `references`           |

The start screen's composer (`start-thread.tsx`) opens the same `#`, `@` and
`$` menus through the same hook (`use-mention-menus.tsx`), asking the instance
the new thread will run on, and its first message carries their mentions and
references. `/` is plain text there: its commands change a thread's settings,
and that thread does not exist yet.

The `/` popover offers `/model`, `/effort`, `/mode`, `/plan`, `/default`,
`/clear-draft` and the skills the thread's connector instance loads for the
project. A skill picked here is plain text, with no chip and no reference.
`/clear` is deliberately not offered:
in Command Code it drops the session's context, no command in the union does
that, and binding it to emptying the textarea would throw away the sentence the
user was writing while keeping every token they meant to drop.

`#` searches the thread's files — its worktree, or the project's folder; on
the start screen, before there is a thread, the project's folder — through
`files.search` (`use-file-mentions.ts`), and says "No files match" when nothing
does, "Searching…" while the first search runs and "Could not search files"
when it fails. Each keystroke is a new search; until it answers, the menu keeps
the rows the last one gave rather than emptying (`heldMenuSource` in
`menu-source.ts`). The turn carries the bare workspace-relative paths as
`mentions`, and the connector decides how to name them to its harness. Because
`#` is also markdown and issue numbers, it needs a query that starts with
neither another `#` nor a digit. So a lone `#` then Enter sends, `# Heading`
closes at the space, and `##` headings, `fixes #12`, `a#b` and
`https://x.dev/#frag` never open it. The digit rule matters because
`files.search` is a substring match: `#12` would list every path with a 12 in
it, and Enter would pick one instead of sending.

`@` lists the thread instance's enabled plugins under "Plugins", then its
enabled skills under "Skills" (`pluginsAtom` and `skillsAtom`, wired in
`use-reference-mentions.ts`; the rows come from `reference-menu.ts`). `$` lists
the skills alone, ungrouped. An instance without the plugins extension answers
no plugins, so `@` then shows its skills. A menu with no rows says why
(`referenceMenuEmptyLabel`): "No plugins or skills" (`$`: "No skills") only
when the harness answered with none, "No plugins or skills match" when the
query filtered them all out, "Loading plugins and skills…" while a list is
still being asked, and "Could not list plugins" (or skills) when one failed.
The atoms start from `[]`, so `menu-source.ts` reads their in-flight `waiting`
flag rather than trusting an empty success, and treats an `unavailable` answer
(no such extension) as none. Both open on an empty query, like
`/`, so `me@x.com` and `a$b` stay closed but a bare `@` lists everything. `$`
also stays closed when its query starts with a digit, so `$5` and `costs $20`
never open. `$HOME` does open, but both menus match the query against names
alone, never descriptions, so it lists nothing unless a skill's name holds
`home`, and Enter still sends.

Every chip stands for exactly one token in the text: `#path` for a file,
`@name` for a plugin and `$name` for a skill, even a skill picked from `@`, so
a plugin and a skill of the same name never share a token. Removing a chip
removes its token and one space beside it (`removeComposerToken`); editing a
token away, even by one character, drops its chip, because after every change
the draft keeps only the chips whose whole token is still in the text
(`retainComposerReferences`). A whole token starts the text or follows
whitespace, and ends the text, meets whitespace, or meets closing punctuation
(`.,;:!?)]}'"`) that is followed by one of those, so `Greet me with $greeting.`
keeps its chip while `#src/a.ts` does not hold a chip for `#src/a`. The draft (`ComposerDraft` in
`apps/web/src/state/ui.ts`) holds the text, the mention paths and the
references side by side, and a send or `/clear-draft` empties all three.

The turn carries the picks from `@` and `$` as typed `references`
(`TurnReference`: `{ kind: "skill" | "plugin", name }`), sent on
`thread.turn.start` only when there are some, and kept on the queued message,
the turn request and the `user_message` row. The sent message's bubble
(`UserMessageRow` in `timeline/message-rows.tsx`) draws the same chips above
its text; a row without any renders as text alone.
Neither the renderer nor the server writes a reference into the prompt: the
connector does, in the words its harness understands ([The spawn](#the-spawn)).

The model picker, on the start screen and in the thread header, has one
section per enabled connector instance (`modelCatalogAtom`), headed by the
instance's name and its connector's generic icon, in the connectors page's
order. Picking a model picks its instance too: the start screen sends both on
`thread.create`, the header on `thread.settings.update`. Until the user picks,
a new thread shows the saved default model under the first instance that lists
it, else the first enabled instance's first model. Once the thread has run
anything (`threadLocksConnector`), the other instances' sections stay listed but
disabled, with a tooltip saying to start a new thread, and a pick in the
thread's own section sends the model alone. The instance a thread runs on, or
would, is `threadConnectorInstanceId` (`apps/web/src/lib/connector-routing.ts`):
the bound session's, else the thread's chosen one while it is enabled, else the
first enabled one.

`/effort` and `/mode` offer what the header pickers offer. Efforts are the
current model's `efforts`, or the whole ladder when it states none, always
lowest first in the contract's `EFFORT_ORDER` (`apps/web/src/lib/efforts.ts`).
Runtime modes are the connector's `capabilities.runtimeModes`, named from one
label table (`apps/web/src/lib/runtime-modes.ts`). Both read the capabilities of
the instance the thread runs on, or would run on before its first turn. When
that instance reports `images: false`, the attach button is disabled with the
reason as its tooltip and a paste or drop is refused with the same sentence.

### Command to events

```
composer
  │ orchestration.dispatch { thread.turn.start }
  ▼
OrchestrationEngine.dispatch            apps/server/src/orchestration/Engine.ts
  │ commandId already receipted? → return the stored receipt
  │ one write mutex, one SQLite transaction:
  │   load stream → foldThread → decide(command, state, ctx, env)
  ▼
decider                                 apps/server/src/orchestration/decider.ts
  │ accepted → [ thread.turn.requested, thread.item.upserted(user_message) ]
  ▼
append → project → watermark → commit → publish
  │
  ├─→ subscribers (threads.subscribe)
  └─→ ProviderCommandReactor
```

The decider is pure: command plus folded stream state in, events out, no clock
and no id minting of its own. A rejection is a result, not an exception — the
command receipts as `rejected` and nothing is appended. `CommandReceipt`
carries `lastSequence`, so a client can wait for its own write to appear on the
subscription.

The `user_message` row is minted here and nowhere else: connectors deliberately
emit nothing for the user's own text, so without this the timeline would show
answers and never questions.

### Binding a session

`ProviderCommandReactor` (`apps/server/src/orchestration/ProviderCommandReactor.ts`)
reacts to `thread.turn.requested` by calling `SessionManager.ensure(doc,
workspaceRoot)` and then `handle.send(turnId, turn)`. `workspaceRoot` is the
thread's own root: its worktree when it was created in one, the project's
folder otherwise (`orchestration/workspaceRoot.ts`).

`SessionManager` (`orchestration/SessionManager.ts`) keeps one driver per
thread. A thread with no `session` in its document is routed by
`ConnectorSelection.fromRegistry`: to the instance the thread chose
(`settings.connectorInstanceId`, picked on the start screen) when that instance
is open, and otherwise — no choice, or the chosen one was disabled or removed
since — to the first _open_ instance in the settings document's own order. A
thread that already has a session is looked up by the session's persisted
`connectorInstanceId`, never by kind — two instances of the same kind can differ
in binary, credentials and model. Once a thread has a session, a running turn or
a message of the user's, the decider refuses to change its connector: the answer
is a new thread. `startSession` or
`resumeSession` produces a raw `SessionHandle`; `makeTurnScopedHandle` wraps it
so runtime events carry our `turnId`, and `ingestSession` forks the fiber that
drains its events into the log.

### The spawn

`packages/connector-cmd/src/session.ts` is one session for one thread; print
mode is one **process per turn**. `turnArgs.ts` builds the prompt and the argv,
`spawn.ts` performs the spawn.

The argv, in the order `buildArgs` emits it:

```
cmd -p "<prompt>" --output-format json --verbose -t --skip-onboarding --no-auto-update
    [--session <sessionId>]
    [--model <id>] [--effort <low|medium|high|xhigh|max>]
    [--permission-mode plan] [--yolo]
    [--add-dir <dir>]… --tools-enable ask_user_question
```

Two flags are decided per turn:

- **`--yolo` on every ordinary turn.** Without it print mode refuses writes and
  shell calls whatever a hook answered. With it the PreToolUse hook still fires
  and a deny still stops the call — recorded under the connector's own argv in
  `packages/testkit/fixtures/cmd/shell-deny-yolo/`.
- **`--permission-mode plan`, and no `--yolo`, on a plan turn.** See §6.

`--tools-enable ask_user_question` is on every turn: a headless run withholds
that tool, and without the flag the model asks its question as prose no card
ever renders.

The prompt is the user's text, then `@mention` lines, then one
`Use the "<name>" skill.` line per skill reference, then one
`Attachment (<mime>): <absolute path>` line per staged file. A plugin reference
is left out, with a `session.warning` saying so, because Command Code has no
plugins. The skill line is the one `fixtures/cmd/skill/` was recorded with; see
[command-code-connector.md](command-code-connector.md#the-prompt).

The environment is built by `envAllowlist` in three passes: the inherited
variables an allowlist names, then the operator's `extraEnv` from the connectors
page, then the session's own `OPENADE_*` control plane — the hook URL, the
ticket file, the thread id and the MCP token — applied last so nothing can
override it. The exact name lists, and why `OPENADE_HOOK_*` is reserved against
`extraEnv`, are in
[command-code-connector.md](command-code-connector.md#environment).

The process is spawned `detached`, so it leads its own process group and a
signal can reach the harness's own children.

### Frames to rows

Three sources describe the same work, and
`packages/connector-cmd/src/translate.ts` makes the overlap idempotent:

| source                 | what it is                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NDJSON on stdout       | the live stream: `run_start`, `turn_start`, `message_start`, `model_request_start/end`, `text_delta`, `thinking_*`, `tool_queued/running/update/completed`, `tool_hooks`, `tool_hook_blocked`, `subagent_*`, `message_update/end`, `turn_end`, `run_end` |
| the session transcript | `~/.commandcode/projects/<slug>/<sessionId>.jsonl`, appended once per completed message, the last flush landing _with_ `run_end`                                                                                                                         |
| PreToolUse hook posts  | one per gated tool call                                                                                                                                                                                                                                  |

Facts that shape the mapping, all from the recordings under
`packages/testkit/fixtures/cmd/`:

- **A turn is a process, not an agent step.** `turn_start`/`turn_end` count
  model round trips — three of them inside one `shell-allow` turn. One user
  turn is `run_start` to `run_end`.
- **The tool input lives on `tool_queued`.** `tool_running` carries no input
  and a null description.
- **The transcript is history, not a live source.** It does not exist at
  `run_start` and is one model round trip behind the frames. It is what carries
  `usage.costUsd`, what survives a restart, and what a resumed session reads.

Tool calls dedupe on `toolCallId`, messages on `meta.messageId`, so the frames,
the transcript and the `run_end` reconcile all land on the same timeline row.
Item ids are minted (`packages/connector-cmd/src/items.ts`) because the
harness's ids are not UUIDv7 and the wire schema insists on it. Tool names map
to `ItemKind` there too:

| tool                                          | row kind            |
| --------------------------------------------- | ------------------- |
| `shell_command`                               | `command_execution` |
| `edit_file`, `write_file`                     | `file_change`       |
| `read_file`, `read_directory`, `glob`, `grep` | `tool_call`         |
| `todo_write`                                  | `todo`              |
| `agent`                                       | `task`              |
| `activate_skill`                              | `skill`             |
| `web_search`, `web_fetch`                     | `web_search`        |
| `mcp__*`                                      | `mcp_tool_call`     |
| anything else                                 | `tool_call`         |

A frame the connector cannot translate becomes `event.unmapped`, carrying the
raw frame — a harness change shows up in the log instead of vanishing.

### Runtime events to orchestration events

`apps/server/src/orchestration/RuntimeIngestion.ts` translates the
connector-neutral events into the log:

| runtime event                                           | orchestration event                             |
| ------------------------------------------------------- | ----------------------------------------------- |
| `session.started`                                       | `thread.session.bound`                          |
| `session.warning`                                       | `thread.error` (`fatal: false`)                 |
| `turn.started` / `turn.completed`                       | `thread.turn.started` / `thread.turn.completed` |
| `turn.plan.proposed`                                    | `thread.plan.proposed`                          |
| `item.*`, `content.delta`, `task.*`                     | `thread.item.upserted`                          |
| `request.opened` / `request.resolved`                   | `thread.approval.opened` / `.resolved`          |
| `user-input.requested` / `.resolved`                    | `thread.userInput.requested` / `.resolved`      |
| `usage.updated`                                         | `thread.usage.updated`                          |
| `context.updated`                                       | `thread.context.updated`                        |
| `model.changed`                                         | `thread.settings.updated`                       |
| `runtime.error`                                         | `thread.error`, plus an `error` row when fatal  |
| `session.ended`, `mcp.status.updated`, `event.unmapped` | nothing logged                                  |

`content.delta` frames fold into the item they belong to, so the log holds
whole `item.upserted` snapshots rather than a delta stream, and streamed text
is coalesced on a 50 ms window on the way in. Without that, an answer of N
delta frames wrote O(N²) bytes and rewrote the thread's whole document N times.

### Rows on screen

The client fold (`packages/client-runtime/src/clientState.ts`) applies the
stream to a `ThreadDetailView`. `apps/web/src/components/timeline/fold.ts`
turns the flat item list into rows:

- a `user_message` opens a segment; the segment still open (the last one, while
  a turn runs) renders its work rows inline;
- a settled segment folds each maximal run of work kinds — `reasoning`,
  `command_execution`, `file_change`, `tool_call`, `mcp_tool_call`,
  `web_search`, `task`, `skill` — into one `work-group` row, the
  "N tools · 4s" disclosure ("Thought for 2s" when the run is only reasoning);
- a settled segment that a `user_message` opened and that did any work ends
  with one `turn-summary` row, "Worked for 12s · 3 files +20 −4" (just "Worked
  for 12s" when no file changed). Its time runs from the user message to the
  turn's last item, task children included, and its file list — one line per
  distinct path, diff line counts summed across the turn — opens from the row,
  with a link to the Changes pane. It lists paths and counts only, never a
  diff; the live segment gets none;
- durations come out of the UUIDv7 ids, which carry their creation millisecond
  in the leading 48 bits; a zero duration is left out of a label rather than
  shown as "0ms";
- tool rows follow the tool's name with a short target — the first of
  `file_path`, `path`, `filePath`, `command`, `pattern`, `url` or `query` in
  the input, first line only, cut to 60 characters;
- while a turn runs, a trailing `working` row shows a spinner, "Working…" and
  the time since the turn began ("12s", "1m 05s", "1h 02m", whole seconds). The
  start is read off the turn id, or off the last `user_message` id while the
  turn is in flight but its id is not filled in yet;
- rows whose `parentItemId` names a task leave the top level and render nested
  inside that task's row;
- each answered approval, question and plan in the snapshot's `decisions` (§5)
  becomes a one-line `decision` row — "Allowed once · npm test", "Allowed for
  session · Shell(npm run \*)", "Denied · …" in the destructive colour,
  "Answered · <question>", "Not answered · …" for a card the runtime released,
  "Plan accepted", "Plan accepted with auto-edits", "Revision requested" —
  placed right after the row holding its `afterItemId`
  (after the task, for a task child's item). In a settled segment the record
  is not folded: it ends the work run, so the work group splits around it. A
  record whose anchor is missing or unknown goes at the end, before the
  working row.

`apps/web/src/components/timeline/timeline-item.tsx` dispatches one component
per `ItemKind`. The list opens at its end and follows new rows while it sits
there; scrolled more than half a screen away, it stops following and shows a
round "Jump to latest" button at the bottom that scrolls back down.

### Closing the turn

`run_end` produces `turn.completed` with a `stopReason` of `end_turn`,
`interrupted`, `error` or `max_turns`. Before the completion event leaves the
session, `session.ts` does the bookkeeping that has to happen while the turn is
still open — once it settles, the engine stops tagging events with its
`turnId`:

1. warn if the gate was silent (tools queued, no hook post — see §5);
2. wait (at most a second) for the process to exit, then re-read the
   transcript, which is where `usage.costUsd` arrives — its last flush lands
   after `run_end`, before the exit;
3. refresh the stored transcript path;
4. emit a plan proposal, if this was a plan turn.

`thread.usage.updated` carries the token counts and cost;
`thread.context.updated` carries used/limit, where the limit is the
`context_window` the last `status --json` reported. `CheckpointReactor` takes
`thread.turn.completed` as its cue to capture a checkpoint (§8).

---

## 5. Approvals

### The path a tool call takes

```
model calls a tool
   │
   ▼
cmd runs the PreToolUse hook                    (.commandcode/settings.local.json)
   │  ~/.openade/bin/cmd-hook.mjs, payload on stdin
   ▼
POST /hooks/pretooluse   Authorization: Bearer <per-thread ticket>
   │                                              apps/server/src/hooks/HookBridge.ts
   ▼
HookBridge.answer(token, body) → the session's registered handler
   │                                    packages/connector-cmd/src/hookAnswers.ts
   ▼
approval gate → PermissionService.decide(...)
   │     packages/connector-sdk/src/approvalGate.ts
   │     apps/server/src/permissions/PermissionService.ts
   │
   ├─ allow  → { permissionDecision: "allow" }
   ├─ deny   → { permissionDecision: "deny", reason: "denied by OpenAde permission rules" }
   └─ prompt → emit request.opened, park on a Deferred
                 │
                 │  thread.approval.opened → card docked above the composer
                 │  user answers → thread.approval.respond
                 │  → thread.approval.resolved → handle.respondToRequest
                 ▼
               { permissionDecision: "allow" | "deny", reason: "decided <d> via OpenAde" }
```

The top half is Command Code's: its hook is how a tool call reaches us. A
harness that asks its host directly instead — over an SDK or JSON-RPC — skips
the script and the bridge and hands its request straight to the same approval
gate; from the gate down the path is identical.

### The direct path, on Claude Code

```
model calls a tool
   │
   ▼
the CLI calls the SDK's PreToolUse hook, in-process   (every call, every mode)
   │     packages/connector-claude/src/toolGate.ts
   ▼
PermissionService.decide(...)  — no waiting here
   │
   ├─ allow  → { permissionDecision: "allow" }  the call runs
   ├─ deny   → { permissionDecision: "deny" }   the model is told it was refused
   └─ prompt → { permissionDecision: "ask" }
                 │  the CLI hands the call to canUseTool, decision made
                 ▼
               approval gate → the same card, the same answers
                 → { behavior: "allow" | "deny" }
```

The hook runs for every call in every CLI permission mode, and its "ask"
reaches `canUseTool` in all of them, `bypassPermissions` — full access —
included. So a sensitive path asks even under full access, and a rule in the
user's own `~/.claude` settings can never skip the ladder. AskUserQuestion and
ExitPlanMode pass the hook with no verdict: they speak to the user rather
than act on the machine. The connector names each call in OpenAde's
vocabulary before the ladder reads it (`approvals.ts`): Bash is a `command`
proposing `Shell(<first word> *)`, the edit tools are `file_write` with
`Edit(<path>)`, the read tools `file_read` with `Read(<path>)`, WebFetch and
WebSearch `web` with `Fetch(…)`, and an MCP tool `mcp_tool` with
`Mcp(<server>.<tool>)`. "Allow for the session" also hands the CLI its own
suggested rules for the call, kept to the session; "allow always" writes
only OpenAde's rule, never the CLI's settings files. A call the CLI
withdraws — the turn was stopped — answers its card `deny`. The full tables,
and which of this rests on a recording, are in
[claude-code-connector.md](claude-code-connector.md#approvals).

### The script and the ticket

`packages/connector-cmd/src/hookScript.ts` generates
`~/.openade/bin/cmd-hook.mjs` — dependency-free node, mode `0700`, rewritten
only when its content hash changes, written temp-and-rename so a running `cmd`
never reads half a script.

**The bearer arrives in a file, not in the environment.**
`OPENADE_HOOK_TICKET_FILE` carries a **path**, and the bearer lives in a `0600`
file at `~/.openade/bin/tickets/<threadId>.ticket` that the session writes when
it opens and deletes when it closes; `OPENADE_HOOK_TOKEN` is still read first
when it survives. It is a path because Command Code strips secret-shaped
variable names out of a hook's environment, which once left every tool call
running unapproved — the observation and the failure are in
[command-code-connector.md](command-code-connector.md#the-ticket-file).

Every failure path in the script prints a `deny`: bridge down, non-2xx, garbage
body, timeout. The one exception is a run that carries no URL and no bearer at
all — an interactive `cmd` in a project whose settings still hold our hook
block. That run belongs to the user, so the script exits cleanly with no output
and the harness uses its own prompt flow.

The timeouts nest: the script's fetch aborts at 570 s, the bridge answers
`deny` at 590 s, the harness's own hook cap is 600 s. Bodies are capped at 1 MiB
and a request carrying an `Origin` header that is not loopback gets `403` — the
hook script is our own child and sends none.

### The ladder

`decidePermission` in `apps/server/src/permissions/PermissionService.ts` is pure
and ordered — deny rules, plan mode, sensitive paths, allow rules, reads, then
the thread's runtime mode. The six steps, the pattern syntax and the
sensitive-path list are in [architecture.md](architecture.md#permissions).

Two things about it matter to this flow: a sensitive path prompts however the
user has widened the rules, and a failure inside the decision logs a warning and
returns `prompt`. It never reads as allow.

### The card and the rules it writes

`apps/web/src/components/approvals/approval-card.tsx` renders the request and
offers four answers. It is docked directly above the composer input by
`apps/web/src/components/composer/pending-card.tsx`, which shows one card at a
time — an approval, then a question, then a plan — across the composer's width,
never in the timeline. Keys while it is up, by default: `1` allow once, `2`
allow for session, `3` always allow, `D` or `Escape` deny; a muted line under
the card names them, read from the live table, as do the buttons' own keycaps.
They are ordinary rows of the keybinding table (§11) — `approval.allowOnce`,
`approval.allowSession`, `approval.allowAlways`, `approval.deny` — so they can
be rebound, and the card only registers handlers for them; it adds no key
listener of its own. The claim rule is their `when` clause,
`approvalPending && !inputFocus && !dialogOpen`: the card must be the one on
screen, focus must be outside a text field, and no dialog, popover or menu may
be in front. `Escape` does not compete with `thread.interrupt` either: that
binding's clause (§7) excludes an approval pending with focus outside a text
field, so the two are disjoint by context. With focus on the page, Escape
denies the call; in the composer, it stops the turn. Modifiers match exactly,
so `Shift+D` does not deny.

`allow-session` and `allow-always` carry a `pattern` — the `patternSuggestion`
the connector proposed, editable in the card before it is accepted
(`pattern-editor.tsx` previews it against the live request using the same
matcher the server enforces, `packages/shared/src/permissionPattern.ts`). The
decider turns it into a rule:

| decision        | rule scope | where it is stored                       |
| --------------- | ---------- | ---------------------------------------- |
| `allow-once`    | —          | nothing persisted                        |
| `allow-session` | `session`  | `permission_rules`, keyed to the thread  |
| `allow-always`  | `project`  | `permission_rules`, keyed to the project |
| `deny`          | —          | nothing persisted                        |

The rule is inserted inside the dispatch transaction, and the engine then
invalidates the `permission_rules` reactivity key so an open settings page
re-reads its list.

Every answer is also kept once the card is gone. The fold appends a
`ResolvedDecision` to the thread's `decisions`: `approval`, the request id, the
decision, the pattern it kept, a one-line subject — the input's `command`,
`path`, `file_path`, `filePath`, `url` or `query`, first line only, else the
tool's name — the time, and `afterItemId`, the last timeline item as the answer
landed. The connector echoes each answer back as `request.resolved`; only the
first, which still finds the request open, is recorded. When the harness
process exits with a card still up — Stop, a crash, an archive — the connector
releases each parked request itself (`deny` for an approval, no answers for a
question), and that event is the first to reach it. The fold tells it apart by
its `connector` actor and records the outcome `unanswered` instead of the
refusal, so the timeline never claims the user chose. The subject comes from
`packages/shared/src/decisionSubject.ts`, so the client's fold, which appends
the same record between snapshots, writes the same words.

While any card is up, the thread's `ThreadSummary` says so: `awaitingInput` is
true and `awaiting` names the most urgent open card — `approval`, then
`question`, then `plan` (§6) — so the sidebar row can show what the thread
waits on without subscribing to it: a bell reading "Needs you" for an approval
or a question, a quieter "Plan ready" mark for a plan.

The patterns are OpenAde's own vocabulary — `Shell(npm run *)`,
`Edit(/src/**)`, `Fetch(…)`, `Mcp(server.tool)` and the rest — whichever
harness proposed them, matched by `packages/shared/src/permissionPattern.ts`
on both sides, so the preview in the card means what the engine will do. The
grammar and the aliases older rules use are in
[architecture.md](architecture.md#permissions); how Command Code's tool calls
map onto it is in
[command-code-connector.md](command-code-connector.md#the-tool-vocabulary).

### Subagents

PreToolUse fires **once** for an `agent` delegation, with the subagent's brief
as the input, and never again for what the subagent then does. Approving the
delegation approves everything it goes on to do; the prompt in that one payload
is all the user gets to judge. The only visibility into the work is the
`subagent_start` / `subagent_progress` / `subagent_stop` frames, which the
connector maps onto the `task` row the `agent` call opened
(`packages/connector-cmd/src/subagents.ts`).

On Claude Code the gate does not stop at the delegation. The CLI runs its
PreToolUse hook inside a subagent too — the hook input names the subagent
(`agent_id`) — so each of the subagent's calls reaches the ladder like the
main loop's, and a card it opens is answered in the same thread. The rows it
produces nest under the Task call's `task` row
(`packages/connector-claude/src/translate/subagents.ts`).

### When the gate stays silent

The gate's failure mode is to open: a hook that does not run produces no
decision and the harness falls back to its own flow. So the session counts
`tool_queued` frames and hook posts, and a turn that queued tools and received
no post emits a `session.warning` saying so — which the timeline shows as an
error row. Plan mode is exempt, because no hook fires there by design.

---

## 6. Plan mode and questions

### Plan mode

Plan mode is the button in the settings row under the composer, `/plan` and
`/default` in the `/` menu, or `Shift+Tab` while the composer has the focus
(`composer.planMode.toggle`, the habit terminal coding agents teach). The key
is only answered while the connector can plan or the thread is already
planning; otherwise, and anywhere outside the composer, Shift+Tab moves the
focus as usual. An open `/` or `@` menu takes Shift+Tab first, to move up its
rows.

Setting a thread's `interactionMode` to `plan` changes the next turn's argv:
`--permission-mode plan`, and **no `--yolo`**
(`packages/connector-cmd/src/turnArgs.ts`).

That combination is deliberate, and it is the whole of plan mode's enforcement.
Plan mode skips PreToolUse entirely, so none of the ladder above runs there:
not the user's deny rules, not "plan mode is read-only", not the sensitive-path
prompt. Adding `--yolo` on top would remove the last thing standing, which is
print mode's own refusal of writes and shell calls; without it the CLI refuses
them itself, which is what the mode claims to be. The recordings this rests on
are in [command-code-connector.md](command-code-connector.md#plan-mode).

The plan survives that refusal. The model writes its plan with an ordinary
`write_file`, and the whole body is in the `tool_queued` frame that announced
the call, so the connector saves the file itself (`plans.ts`,
`materializePlan`) and the refused write is shown as a saved plan rather than a
red failed row.

Finding the file the plan landed in takes three sources in order — the plans
index, this run's own frames, then an mtime scan fenced against the other
sessions writing into the same global directory
(`packages/connector-cmd/src/plans.ts`, and
[command-code-connector.md](command-code-connector.md#finding-the-plan)).

The proposal becomes `thread.plan.proposed` while the turn is still open, and
the card (`apps/web/src/components/approvals/plan-card.tsx`), docked above the
composer like the approval card (§5), offers three answers: `1` accept, `2`
accept and run, `3` opens the revision field, named in the same muted line
under the card. They are the table rows `plan.accept`, `plan.acceptAndRun` and
`plan.revise`, live while `planPending && !inputFocus && !dialogOpen`. No plan
row binds `Escape` — a plan does not block the turn on an answer, so the card
has nothing to deny. `ProviderCommandReactor` acts on
`thread.plan.responded`:

| action        | settings change                                                  | follow-up turn                            |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `accept`      | `interactionMode: "default"`                                     | "Implement the approved plan at `<path>`" |
| `accept-auto` | `interactionMode: "default"`, `runtimeMode: "auto-accept-edits"` | the same                                  |
| `revise`      | `interactionMode: "plan"`                                        | the feedback text, or "Revise the plan"   |

The plan's path travels on the `thread.plan.responded` event rather than in a
reactor's memory: the fold clears `pendingPlan` on that very event, so carrying
it is what lets the accept turn survive a restart between proposing and
accepting.

The answer is recorded in the thread's `decisions` as §5 describes: kind
`plan`, the turn id, the action, and the plan file's name as its subject.

### Plan mode, on Claude Code

A plan turn runs the Claude Code CLI in its own `plan` permission mode, set
with `setPermissionMode` before the turn's message is written; the next turn
out of plan mode sets it back (`packages/connector-claude/src/session.ts`).
The ladder above does run here — the PreToolUse hook fires in every mode — and
its plan rung refuses every non-read, which is what keeps the turn read-only.

```
model writes its plan file      <config dir>/plans/<name>.md
   │  the hook lets this one write through with no verdict;
   │  the CLI's plan mode allows its own plan file and nothing else
   ▼
model calls ExitPlanMode
   │  the CLI fills in the input: plan (the file's markdown), planFilePath
   ▼
canUseTool   packages/connector-claude/src/interactions.ts
   ├─ item.completed  a `plan` row with the markdown
   ├─ turn.plan.proposed { planMarkdown, planPath }
   └─ { behavior: "deny", message: "…stop here…" }
        │
        ▼
the model stops; the CLI's result ends the turn
```

The card and the answers are the ones above: the reactor's settings change
reaches the session as `setPermissionMode`, and "Implement the approved plan
at `<path>`" names the CLI's own plan file, which the implementation turn can
read. Task and its subagents are refused in a plan turn by the same rung that
refuses writes.

### Questions

`ask_user_question` is withheld from a headless run, which is why every turn
passes `--tools-enable ask_user_question`. Print mode has no interactive
channel, so the tool call takes the hook road for a different purpose
(`packages/connector-cmd/src/hookAnswers.ts`):

1. the payload's `questions[]` are normalised
   (`packages/connector-cmd/src/questions.ts`) and emitted as
   `user-input.requested`;
2. the post parks; a question card
   (`apps/web/src/components/approvals/question-card.tsx`) opens above the
   composer with radio buttons, checkboxes for `multiSelect`, and a freeform
   field where allowed. Number keys `1`–`9` (`question.option.1`…`9`, live
   while `questionPending && !inputFocus && !dialogOpen`) pick option N — or
   toggle it, in a multi-select — of the question whose block holds focus,
   else of the first question;
3. `thread.userInput.respond` releases it;
4. the tool is **denied**, with the user's answers — in the question's own
   words, not our ids — as `permissionDecisionReason`. The model reads them as
   context instead of waiting for a prompt that will never come.

The answer is recorded in the thread's `decisions` (§5) as `question`,
`answered`, with the first question's header — else its text — as the subject.
Once the card closes, that record is what the timeline keeps of it: one line,
"Answered · <question>", where the exchange happened. A question the process
exit released reads "Not answered · <question>" instead (§5).

On Claude Code, AskUserQuestion is offered to SDK sessions as it is, and it
takes the direct path (`packages/connector-claude/src/interactions.ts`):
`canUseTool` emits `user-input.requested` — ids minted by position, every
question `freeform` because the CLI always lets the user type their own
answer — and holds the call until `thread.userInput.respond`. The tool is
then **allowed**, with the answers in its `updatedInput`: `answers` keyed by
each question's text, the chosen labels joined by ", " and the user's own text
after them. The CLI runs the tool with them and the model reads the result as
the user's answer. A stopped turn or a closed session answers the card with
nothing and denies the call.

---

## 7. Stop, and the queue

### Stop

The Stop button and the `thread.interrupt` binding both dispatch
`thread.turn.interrupt`. The binding is `Escape` with
`when: turnRunning && !dialogOpen && (inputFocus || !approvalPending)`: it
fires only while a turn runs and no dialog or menu is open, and not when an
approval card is up and focus is outside a text field — there Escape denies the
call instead (§5). The composer publishes `turnRunning` and answers the
command. The decider rejects it when no turn is
running or one is already stopping, and otherwise emits
`thread.turn.interrupted`, which sets `interrupting` on the thread document
without clearing `currentTurn` — the turn stays in flight until something
settles it.

`ProviderCommandReactor` calls `handle.interrupt(turnId)`. The session marks
itself interrupted and runs the kill ladder in
`packages/connector-cmd/src/spawn.ts`: `SIGINT` to the **process group**, then
`SIGKILL` after 5 s, then a `pgrep -g` sweep that SIGKILLs anything still in the
group. A bare SIGINT leaves a child that ignores it — or a `shell_command`
grandchild holding the pipe — running forever, and with it a turn that never
settles.

A run killed this way exits 130 and writes no `run_end` and no transcript. The
session normalises the exit code to 130 whatever signal finished it off, so the
turn settles `interrupted` rather than `error`. If there is no live session at
all, or the interrupt itself fails, the reactor appends the synthetic
`thread.turn.completed` itself rather than leaving the thread stuck in
`running`.

The consequence for the next turn is §13: a SIGINT'd run leaves no transcript,
so its session id is not resumable.

### The queue

A harness that cannot steer — a print-mode one takes no mid-turn message — has
a send made while a turn is running go on a queue instead of racing the
session. `thread.turn.start` with
`queued: true` emits `thread.message.queued`, carrying the whole composer input
— text, attachments, mentions and references. An interrupt that has not settled
yet always queues, whatever the caller asked for.

The strip (`apps/web/src/components/composer/queue-strip.tsx`) is a projection
of `doc.queue`; nothing is removed locally. Each row ends with what the message
carries besides its text (`queue-summary.ts`), counted under the draft tokens:
`#×2 $×1 @×1 +1 file(s)` is two file mentions, a skill, a plugin and an
attachment. `thread.queue.remove` and `thread.queue.reorder` are commands, and
the reorder event carries the whole new order rather than the move, so a
projector never replays arithmetic.

Draining happens on `thread.turn.completed`. The dequeue is chosen **inside**
the append transaction, on the document as it is at append time, so a
`thread.queue.remove` decided in between cannot let a message leave the strip
and be sent anyway. The follow-up turn is dispatched with `queued: true` and
its receipt is read: if anything makes the decider refuse it — a sibling thread
starting a checkpoint restore, the user archiving the thread — the message is
re-queued rather than destroyed. Nothing drains while a turn is still in
flight: that completion was not the one that freed the connector.

A completion only ends the turn it names. Archiving a thread mid-turn closes its
session, and the close settles that turn when it gets there; by then the thread
may be unarchived with a newer turn running — and since the reactor handles the
archive's close before the newer turn's request, the settlement lands after
`thread.turn.requested` and before `thread.turn.started`. Both folds (server and
client) count a turn as in flight from `thread.turn.requested` and ignore a
`thread.turn.completed` whose `turnId` is not the turn in flight, so the late
settlement cannot end the newer turn.

### Steering

A harness that can take a message mid-turn says so with
`capabilities.steering`. Its `session.started` carries the capabilities, and
`RuntimeIngestion` copies them onto `thread.session.bound`, so the thread's
session in the read model knows what its harness can do. Command Code
declares `steering: false`, and its threads keep the queue exactly as above;
Claude Code declares `steering: true`.

`thread.turn.steer` carries the same input as a send — text, attachments,
mentions — and the decider answers it from the thread as it is:

| The thread                               | What the steer becomes                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| no turn running                          | a new turn, as an unqueued `thread.turn.start` would start       |
| a turn stopping (`interrupting`)         | `thread.message.queued`, drained on that turn's completion       |
| a turn running, not known to steer       | `thread.message.queued`, as a send would queue it                |
| a turn running, the session cannot steer | rejected: "this thread's harness cannot take a message mid-turn" |
| a turn running, the session steers       | `thread.turn.steered` plus the user's row, both on that turn     |

The first row absorbs a race: the turn ended while the user was still typing,
and the message simply starts the next one. "Not known to steer" is a thread
whose session has not bound yet — the first turn of a new thread while its
harness starts, or any Command Code turn before its first run has ended, since
that connector learns its session id only then — or a session bound before
capabilities were recorded. Nothing has said the harness steers, and nothing
has said it cannot, so the message waits on the queue rather than failing. The
same checks as a send bar a steer outright — a missing or archived thread, a
checkpoint restore in this thread or a sibling.

`thread.turn.steered` changes nothing in either fold: the turn it names keeps
running, and the user's row arrives as its own `thread.item.upserted` stamped
with that turn, so the timeline shows the message inside the turn it joined.
`ProviderCommandReactor` calls `handle.steer(turnId, input)`, which the
turn-scoped handle delivers only while that turn is still the active one. When
there is no live handle, or the steer fails — the turn settled between the
decision and the call, say — the message is dispatched again as
`thread.turn.start { queued: true }`: a new turn when none is running, the
queue when one is. Should even that be refused, it goes onto the queue
directly, as a refused drain does. The row the decider already wrote stays in
the turn it was meant for, so a message that fell back shows twice: once where
it was sent, once where it was answered.

The connector writes the message into its harness while the turn runs, with no
new `turn.started`, and keeps the running turn open until its harness has
answered the steered message too, so the turn still ends with exactly one
`thread.turn.completed`. A harness may take the message into the work it is
doing, or finish what it was doing and then answer the message on its own; a
connector tells the two apart from what its harness reports about each
message, not by counting the harness's own completions, and holds the turn
open across any completion that leaves a steered message unanswered. Usage
reported along the way adds up into the one turn's. A connector checks there is
still a turn to join in the same step that would end it, so a steer that races
the turn's end either joins it or is refused and falls back to the queue as
above. Stop ends the whole turn, and a steered message the harness had not
taken up yet is withdrawn with it rather than answered afterwards. The Claude
Code connector's reading of its harness is in
[architecture.md](architecture.md#the-claude-code-connector).

In the composer (§4), Enter on a running thread whose harness steers sends
`thread.turn.steer`; `Cmd+Enter` still queues, and on a harness that cannot
steer both keys queue as they always have. The client decides from the same
fact the decider does — `capabilities.steering` on the thread's bound session
— so until the session binds, a running thread queues.

---

## 8. Checkpoints, diffs and restore

### Capture

`CheckpointReactor` (`apps/server/src/orchestration/CheckpointReactor.ts`) takes
`thread.turn.completed` as its cue and calls `CheckpointHook.capture`. The
implementation (`apps/server/src/git/CheckpointStore.ts`) writes a hidden ref:

```
refs/openade/checkpoints/<threadId>/<turnId>
```

The commit is built from a **temporary index**, so capture never disturbs the
user's real index or staging area. A workspace that is not a git repository has
nothing to snapshot and reports `null` rather than an error. The checkpoint's
id is a pure function of the commit SHA — the first 32 nibbles with the version
and variant fields forced to UUIDv7 — so `checkpoints.list` and
`thread.checkpoint.created` always agree.

Capture and restore run in the **thread's own root**: its worktree when it was
created in one, the project's folder otherwise. HEAD and the index belong to
one worktree, so a worktree thread's snapshot has to be taken there. The
hidden refs, on the other hand, are shared by every worktree of a repository,
which is why prune — on `thread.deleted` and `project.removed` — keeps running
from the project's root: it reaches a worktree thread's refs just the same,
even after that worktree has been removed.

### Restore

Restore is a durable work order, in three events:

```
thread.checkpoint.restore  (command)
   ▼
thread.checkpoint.restore.requested   ← recorded before any git runs
   ▼  CheckpointReactor: git restore from the commit + git clean -fd
   ├─ thread.checkpoint.restored
   └─ thread.checkpoint.restore.failed  (locked directory, pruned ref, dirty submodule)
```

A request with no recorded outcome is replayed at boot, so a crash between the
receipt and the git work cannot drop it. The decider refuses a restore while a
turn is running, while this thread is already restoring, and while **any
sibling thread that shares its workspace root** is — the git work rewrites
that whole directory, so the exclusion is per root: every local thread of a
project shares the project's folder, and every thread of one worktree shares
that worktree, while a worktree thread's restore holds up nobody working
elsewhere. For the same reason a restore in flight bars a new turn in the
same directory.

`ThreadDetailSnapshot.restoring` carries the in-flight checkpoint, so a window
reloaded mid-restore still says "Restoring the worktree…" instead of offering a
button that can only be rejected.

### The Changes pane

`apps/web/src/components/panes/changes/changes-pane.tsx` is the dock's first
tab. A scope select at the top picks what to compare
(`selection.ts` turns each choice into one `git.diff` payload):

- **This turn** — the turn selector and the restore controls, which show in
  this scope only. The selector picks the working tree, one turn's checkpoint,
  or checkpoint to checkpoint.
- **Branch vs base** — `git.diff` with `mergeBase`: everything the branch has
  done since it forked, commits and uncommitted work together. The base is
  the worktree's own `baseBranch` for a thread started in one, else the
  repository's default branch from `git.branches`; with neither the pane says
  "No base branch to compare with". On the base branch itself the fork point
  is `HEAD`, so a line under the select says only uncommitted work shows.
- **Uncommitted** — the working tree against `HEAD`, both ends omitted.

`git.diff` answers with the file list, because `GitDiff.files` already
carries the path, the `+`/`-` counts and the per-file patch. `git.status` is
read alongside for the branch line and to tell "not a git repository"
(`isRepository: false`) from "nothing changed". Every call names the thread,
so a worktree thread's pane shows its worktree.

A Split toggle beside the select lays each patch out side by side
(`InlineDiff`'s `diffStyle`, passed to `@pierre/diffs`); it defaults to
unified, and the timeline's own file-change rows are always unified. The
scope and the diff style are remembered for every thread in localStorage
(`useChangesScope`, `useDiffStyle` in `state/ui.ts`); a stored value the pane
does not know reads as the default.

Nothing refetches on a command receipt, because both writes that move the
worktree finish _after_ the command that started them. The pane watches the
thread snapshot instead (`use-changes-refresh.ts`): a restore records the
sequence it was accepted at and refetches once the snapshot passes it; a turn
refetches when `currentTurnId` falls back to null. A refresh — those two and
the refresh button — rereads every git read of the project, the same
per-project revision a branch switch bumps, so the header follows along.

`checkpoints.list` intersects the timeline's own fold of
`thread.checkpoint.created` with the refs that still exist in the repository,
so the pane never offers a restore that can only fail.

### Branches

`git.branches`, `git.branch.create` and `git.checkout`
(`apps/server/src/git/Branches.ts`, behind `Git.ts`) run in the same root the
diff does. The list reads `git for-each-ref` over `refs/heads` and
`refs/remotes` (a remote's own `HEAD` pointer is skipped) and `git worktree
list`, which marks a branch checked out in another worktree. The default
branch is the remote's `HEAD` (`origin`, or the first remote), else a local
`main` or `master`, else `init.defaultBranch` when that branch exists, else
the current branch. The remote's `HEAD` is named by its local branch when one
exists (`main`) and by the remote-tracking one otherwise (`origin/main`, in a
clone made with `-b develop`), so a worktree can always be cut from it and the
Changes pane can always find its merge base.

A branch is always cut with `--no-track`: one cut from `origin/main` would
otherwise track it, and its first push would land on main. Names are refused
before git sees them when they start with `-` or carry anything but letters,
digits, `.`, `_`, `/` and `-`, and then `git check-ref-format --branch` has the
last word. A switch — `git.checkout`, or a create with `checkout` — is refused
with `conflict` while a tracked file has uncommitted changes, and while a turn
runs (or a restore rewrites files) in any thread whose root is the same
directory; every local thread of a project shares its root, so one busy local
thread holds them all. Untracked files do not count as dirty: git carries them
across a switch, and a harness session writes its own untracked config into
the workspace. A remote branch is checked out as a local branch tracking it.

`git.diff` with `mergeBase` compares the working tree, uncommitted and
untracked work included, with `git merge-base HEAD <mergeBase>`: the branch's
own work, without the base's later commits showing up as reverted.

The thread header's branch picker (`apps/web/src/components/git/branch-picker.tsx`)
is the client of these. Its trigger shows the branch the thread's root is on
(`detached` on a detached HEAD). When the header is narrow the branch keeps
its room: the title shrinks twice as fast, and below 32rem the header's Commit
button drops its label for its icon and tooltip. For a local thread it opens a search over the
branches in two groups, Local and Remote; a remote branch whose local twin
exists is left out, since picking it would switch to that local branch anyway,
and a branch checked out in another worktree is listed but disabled. Picking a
branch runs `git.checkout`; a query that looks like a branch name and names no
existing branch — local, remote, or a remote's short name — offers
`Create branch "<query>"`, which cuts it from the current branch with
`checkout`; a query git would refuse as a name offers no create, and the list
says which rule it breaks (no spaces, `..`, a leading `-`, and so on). A refusal (a dirty tracked tree, a running turn in a sibling local
thread) is a toast with the server's message, and nothing is stashed. The
trigger is disabled while the thread's own turn runs, and the popover says that
a switch moves every local thread of the project. For a worktree thread the
popover only shows the branch, the base it was cut from and the path, because
the thread owns that branch.

After a successful switch or create, every git read of the project refetches —
branches, status and each diff range, for every thread — through a per-project
revision atom that each read in `gitAtoms.ts` depends on; a switch in the
project's folder moves all of its local threads, so refreshing only the scope
that asked would leave its siblings stale. The agent can switch branches as
well, so the picker also refetches its list when a turn finishes. While the
list cannot be read — offline, or a client that serves no git — the trigger is
disabled with the reason in its tooltip.

### Commit, push and pull requests

`git.commit` and `git.push` (`apps/server/src/git/Commits.ts`) run in the
same root, as the user: no author environment (that is the checkpoint store's,
for its hidden refs only) and never `--no-verify`, so the user's identity,
signing config and hooks apply. Without `paths` a commit stages everything
(`git add -A`). With `paths` the index is reset first and only those paths are
staged (`--literal-pathspecs`), so a file staged earlier in a terminal but left
unchecked does not ride along; it stays in the working tree, unstaged. A staged
rename is one row named by its new path, and picking it stages its old path
too, so the commit records the rename rather than a copy. Nothing
staged is `conflict` "Nothing to commit.", a hook's refusal is `conflict` with
the hook's own output, and a commit is refused like a switch while a turn runs
in that root. The index is saved (`git write-tree`) before anything is staged
and put back (`git read-tree`) whenever no commit comes of the call — a path git
cannot stage, nothing staged, a hook's refusal — so a failed commit never costs
the user what they had staged. The reset names the whole repository (`:/`)
rather than being pathless, because a pathless `git reset` also ends a merge
or cherry-pick in progress. Two states are refused before anything is touched,
both `conflict`: unresolved conflicts ("Resolve the conflicts in … before
committing.", since staging them would record the markers as the resolution),
and, as `git commit -- <paths>` refuses, a commit of chosen paths while a
merge, cherry-pick or revert waits for its commit — that commit takes every
change. Committing everything mid-merge makes the merge commit.

A push goes to the branch's `branch.<name>.remote`, else `origin`, else the
only remote; no remote is `unavailable`. A branch with an upstream is pushed
with a plain `git push`; one without gets `git push -u <remote> <branch>`, so a
branch cut `--no-track` from `origin/main` lands on its own name. Pushes run
with `GIT_TERMINAL_PROMPT=0` and a five-minute ceiling: a credential prompt
fails fast instead of hanging the call.

`git.pullRequest.create` (`apps/server/src/git/GitHubCli.ts`) goes through the
GitHub CLI behind the `GhRunner` service, which finds `gh` on PATH and in the
Homebrew directories a Finder launch leaves out. `gh --version` failing is
`unavailable` "gh not available", `gh auth status` failing is `unavailable`
(not authenticated), and then `gh pr create --head --base --title --body`, all
argv, opens the pull request from the current branch. The base is the
payload's, else the branch the thread's worktree was cut from, else the
default branch, with a remote prefix (`origin/main`) dropped. When a pull
request already exists its URL comes from gh's refusal, or from `gh pr view`,
with `created: false`. Tests swap in a fake runner that answers with gh's own
wording; nothing talks to GitHub.

The thread header's git actions control
(`apps/web/src/components/git/git-actions-control.tsx`) is the client of these:
a Commit button, and a menu with Commit, Commit & push, and Commit, push &
create PR. An action is a stack of steps, planned from the root's status and
branch list (`planGitAction` in `apps/web/src/lib/git-actions.ts`): a commit
only when something changed; a push after a commit, and otherwise only when
the branch has no upstream yet (the push then sets it, `-u`) or is ahead of
it; the pull request last. Pushing and the pull request need a remote. Each
action that cannot run says why — in the button's tooltip, or under its menu
item: no changes and nothing to push, a turn running (the whole control is
disabled while this thread's turn runs), not a repository, a detached HEAD, no
remote, the branch behind its upstream, or a pull request from the default
branch. Files also change outside a turn, in an editor or a terminal, so the
control rereads every git read of the project when the user comes back to the
window — focus, or the page turning visible, counted once when both fire
(`useWindowReturn` in `apps/web/src/lib/window-return.ts`) — and the status when
its menu opens. A Commit disabled as "no changes" would otherwise stay so with
no click of its own to refresh it.

Any action that commits opens the commit dialog first. Its message starts as
the thread's title — `Update N files` while the title is still `New thread` —
then a blank line and `Changed files:` with one `- path` line each; nothing
writes the message for the user. Opening the dialog refetches the status, and
until the user types the message follows it and the checkboxes: it counts and
lists the files still checked, not the ones read before the dialog opened or
left out since. Every path
`git.status` reports is listed with a checkbox, untracked files included and all
checked, so a file the user does not want can be left out. OpenAde's own hook
file never appears there: while a session holds it, `info/exclude` keeps it out
of the status (see "The CLI's own config files"). `paths`
is sent only when something is unchecked. With every file unchecked there is
nothing to commit: a plain commit is disabled, while the other two actions skip
the commit and run what is left (the button then reads `Push`,
`Push & create PR` or `Create PR`), so a pull request stays reachable when the
only change is a file nobody wants committed. A pull request in the same run takes
its title (the first line) and body (the rest) from the commit message; with
nothing to commit, a push runs straight away and a pull request asks only for
its title and body.

The steps run in order (`runGitSteps`) and the first refusal stops the run, so
a failed commit never pushes and a failed push opens no pull request. Each step
has one toast that starts as `Committing…`, `Pushing to origin/<branch>…` or
`Creating pull request…` and turns in place into its outcome: `Committed
<sha>`, `Pushed to …`, `Pull request created` or `Pull request already open`
with an Open action — or `<Step> failed: <the server's message>`, which is how
a hook's refusal, a rejected push or `gh not available` reach the user. After a
commit or a push every git read of the project refetches, the way a branch
switch does. The last pull request URL is remembered per thread in
localStorage (`usePullRequestLink` in `apps/web/src/state/ui.ts`, web links
only) and offered as View pull request, which opens it in the system browser
(`openExternal`).

### Worktrees

`git.worktree.create` (`apps/server/src/git/Worktrees.ts`) gives a new thread a
directory of its own. The branch is the settings document's `git.branchPrefix`
(default `openade/`) followed by `branchSlug` of the free-text name
(`apps/server/src/git/branchSlug.ts`: lowercase ASCII, digits and single
dashes, at most 40 characters cut at a word boundary, `thread` when nothing is
left). A prefix that makes an invalid name is refused as `invalid`, naming the
setting. The base is the payload's, else the default branch, and it has to
resolve to a commit. The worktree goes in
`<OpenAde home>/worktrees/<project slug>/<slug>`, and `-2`, `-3`… is appended
until neither a branch nor a directory of that name exists — two projects with
the same name share the parent directory. `git worktree add --no-track -b`
runs from the project's root, and the answer (real path, branch, base) is what
`thread.create` records as the thread's `worktree`.

`git.worktree.list` reads `git worktree list --porcelain`, the project's own
checkout first. `git.worktree.remove` takes a path only when it is a
registered worktree of the project's repository, neither the project's own
folder nor the repository's main checkout (they differ when the project was
added from a linked worktree), compared by real path; refuses with `conflict`
while a thread that is not deleted (archived ones included) still works there
or while another project was added from that folder; and runs `git worktree
remove`. git refuses a tree with modified or untracked files, and that
refusal is answered as `conflict`, saying the removal would lose that work;
`force` removes it anyway. The branch
is never deleted, so committed work survives, and `git worktree prune`
follows.

`git.worktree.setup` streams the project's setup script
(`apps/server/src/git/SetupScript.ts`). The script is read from the settings
document's `projectSettings[projectId].setupScript`, never from the payload,
and a missing or blank one answers a single `skipped` frame. It runs as
`/bin/sh -c <script>` in the worktree, with `OPENADE_WORKTREE_PATH` and
`OPENADE_PROJECT_ROOT` set, detached so it leads its own process group.
stdout and stderr arrive as `output` frames, capped at 1 MiB with a notice,
and an `exit` frame carries the exit code (or the signal) last. A stream that
ends first — the client went away — kills the whole group, SIGTERM and then
SIGKILL, so nothing the script started outlives it. `git.worktree.remove`
waits for any such stop in that worktree to finish before it removes anything.

### Starting a thread in a worktree

The start screen's composer has a second picker beside the project's
(`apps/web/src/components/thread/workspace-mode-picker.tsx`): **Local**, the
project's own folder that its other local threads share, or **New worktree**.
The choice is remembered per project in localStorage (`useWorkspaceMode`). New
worktree is disabled, with a tooltip saying why, when `git.branches` answers
that the folder is not a repository. With it picked, a second select offers
the base branch — local branches, then remote ones — opening on the list's
`defaultBranch`.

Sending in that mode runs `start-in-worktree.ts`, a sequence of injected steps:

1. `git.worktree.create` with the first non-blank line of the message as the
   name. The branch is the prefix and its slug (`openade/fix-login-redirect`),
   the directory `~/.openade/worktrees/<project slug>/<slug>`. A refusal —
   not a repository, a bad prefix, an unknown base — is a toast with the
   server's message, and nothing exists yet.
2. `git.worktree.setup`, the project's setup script in the new directory.
   `worktreeSetupAtom` (`packages/client-runtime/src/gitCommands.ts`) folds
   the stream's frames into the run so far, so the panel above the composer
   (`worktree-setup-panel.tsx`) shows the output as it arrives. Its Stop
   button interrupts the atom, which ends the stream and kills the script.
3. When the script exited 0, or the project has none, `thread.create` with the
   `worktree`, then the draft is sent as the first turn and the screen moves
   to the thread.
4. Otherwise the sequence stops before the thread exists. The panel names how
   the script ended (`Setup script exited 3`, killed, stopped) and keeps its
   output. **Start anyway** runs step 3 in the worktree as it is; **Discard
   worktree** asks first, then removes the directory with `force` — whatever
   the script wrote there goes, and the branch stays.

The pickers and the composer wait from step 1 until the thread starts or the
worktree is discarded, and the draft stays put throughout, so a discarded
attempt can be sent again. Leaving the start screen before then leaves nobody
to choose (`use-start-in-worktree.ts`): a running setup is stopped and the
worktree removed with `force` — the server holds a removal until any setup run
in that worktree has finished stopping, so a script still unwinding from
SIGTERM is not writing into a tree git is deleting — as is one waiting on Start
anyway or Discard,
each with a toast saying so and that the branch is kept. A thread that was
already being created when the user left is kept, but its first message is
not sent and the screen does not pull the user to it — the draft waits in that
thread's own composer. Once the thread exists, its header's branch picker
shows the branch with a fork mark and the path in a tooltip, and its sidebar
row carries a fork mark.

### Deleting a worktree thread

The sidebar row menu and Settings → Archived threads confirm a delete with the
same dialog (`apps/web/src/components/sidebar/delete-thread-dialog.tsx`). For a
local thread it is only the delete: the project's folder is left alone. A
thread with a worktree adds a checkbox, checked by default, **Also remove the
worktree at `<path>`**, saying the branch is kept with its commits.
`delete-thread.ts` runs the steps:

1. `thread.delete`. A refusal is the usual toast, and nothing else happens.
2. Only after an accepted delete, and only with the box checked,
   `git.worktree.remove` without `force`. Success is a toast, "Worktree
   removed — branch `<branch>` kept".
3. git refuses a tree with modified or untracked files, answered as
   `conflict`. That is a toast with the server's message and **Remove
   anyway**, which stays until it is answered. Taking it opens a second
   confirmation saying the uncommitted work will be lost, and only confirming
   that removes with `force`. Letting the toast go keeps the worktree.

The second confirmation is mounted above the routes
(`WorktreeForceRemovalHost` in `__root.tsx`), because the sidebar row that
started the delete is gone once its thread is. **Remove anyway** taken on
several toasts queues their confirmations, shown one after another in the order
they were asked, so none is dropped unanswered. The conflict is also the
expected answer to a race: the session closes asynchronously after
`thread.delete`, and a harness can still hold an untracked config file in the
worktree for a moment, so **Remove anyway** is the way through that too.

Removing a project deletes its threads but removes none of their worktrees;
its confirmation says so when any of them has one (`removal-copy.ts`).

---

## 9. Attachments

Only images are staged: the server refuses any other bytes, so the composer
gates attaching on `capabilities.images` alone. A connector's
`capabilities.attachments: "files"` says it could carry any file, and is read
once staging accepts more than images.

Print mode has no image flag. The path around it:

1. the composer reads the pasted or dropped file and calls
   `attachments.stage({ threadId, name, base64 })`;
2. `apps/server/src/attachments/AttachmentStore.ts` sniffs the media type from
   the file's own magic bytes — PNG's signature, JPEG's `FF D8 FF`,
   `GIF87a`/`GIF89a`, `RIFF….WEBP` (`packages/shared/src/imageBytes.ts`), never
   the name or the declared type, so a `.png` that is really a shell script is
   refused — checks `MAX_ATTACHMENT_BYTES` (8 MiB) on the base64 length before
   decoding and again on the decoded bytes, and writes the file as
   `<sha256 prefix>-<sanitised name>.<ext>` under
   `~/.openade/attachments/<threadId>/`, with the extension the sniff chose,
   mode `0600` in a `0700` directory;
3. the reply is a `StagedAttachment` — path, name, mime, size, sha256;
4. `thread.turn.start` carries that **reference**. The bytes never enter the
   event log, which is replayed on every boot and streamed to every client;
5. `turnArgs.ts` puts the attachments directory on the argv as `--add-dir` and
   names each file in the prompt as
   `Attachment (<mime>): <absolute path>`;
6. a timeline thumbnail fetches the bytes back with `attachments.read`, which
   re-sniffs, re-checks the size, and resolves symlinks before refusing any path
   that lands outside the thread's own directory.

Claude Code takes images in the message itself, so step 5 differs there: the
connector reads the staged file, sniffs it again, and sends its bytes as a
base64 image content block ahead of the text
(`packages/connector-claude/src/attachments.ts`). The model sees the picture
without a tool call. The attachments directory is still among the CLI's
readable directories, for any file that is not an image, which is named by
path as on Command Code.

`~/.openade/attachments` is the very directory `ConnectorServices.attachmentsDir`
names, so a staged file is already where the connector expects it and no second
copy is made.

`AttachmentReactor` purges a thread's directory on `thread.deleted` — not on
`thread.archived`, since an archived thread can be reopened and its timeline
still asks for thumbnails. It also sweeps, at boot, files no thread document
references: a paste that never became a message. Files younger than one hour
are left alone, because the previous process may have staged one just before it
went away.

---

## 10. The browser pane

The dock's Browser tab gives the agent a real browser and lets a person take it
over mid-call.

### Two modes

`apps/server/src/browser/driver.ts` picks one per session:

- **`cdp-attach`** — the desktop launched the server with `OPENADE_CDP_PORT`
  set, which it does only when the browser pane is enabled (the port is an
  attach surface; see [architecture.md](architecture.md#the-mcp-gateway-and-the-browser)).
  The driver lists CDP targets through `agent-browser --cdp <port> tab --json`
  and pins the pane's `<webview>` guest, identified by the marker page it loads
  (`GET /browser/attach/:threadId`). There is no frame to ship: the webview is
  already showing the page, and human input lands in the guest directly.
- **`owned-chromium`** — no CDP endpoint, or no webview target inside the
  attach window. `agent-browser` runs its own headless Chrome, the driver
  connects its `stream` WebSocket, and the pane renders the JPEG frames that
  come back and forwards gestures into it.

`apps/server/src/browser/agentBrowser.ts` finds the CLI (`OPENADE_AGENT_BROWSER`,
then `agent-browser` on `PATH`) and runs every call as argv-form `execFile`,
never a shell. A missing binary is not fatal: the service reports `binary:
null`, every call fails with `AgentBrowserUnavailable`, and the pane renders an
install prompt keyed off the exact message constant. The daemon session is
named `ade-<threadId>` and carries a 300 s idle timeout — for a CDP attachment
that timeout is the only thing that reaps it, because closing that session would
destroy a tab the desktop owns.

A session is lazy: `browser.subscribe` creates the state ref but not the
browser. The driver opens on the first tool call or human navigation, so opening
the pane never launches Chrome.

### Tools

The agent reaches the browser through MCP. `apps/server/src/mcp/McpGateway.ts`
serves one loopback `POST /mcp` endpoint with a per-thread bearer, minted when
the connector asks for the endpoint and revoked when the session ends.
`packages/connector-cmd/src/config.ts` registers it in the CLI's own local MCP
scope, with the bearer left as a `${OPENADE_MCP_TOKEN}` placeholder the harness
resolves at launch, so the per-session token never touches disk.

The catalogue is `apps/server/src/browser/tools.ts`: `browser_open`,
`browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_wait`, `browser_get`,
`browser_screenshot`, `browser_eval`, `browser_tabs`. Calls are serialized per
thread. Results cap at 64 KiB of text, counted in bytes;
`browser_screenshot` adds an image block.

Timeline rows for `mcp__openade__browser_*` come from the harness transcript
like any other tool call — the gateway emits none, or every row would appear
twice.

### Human control

Each session carries an **epoch** that human input bumps. A prepared call
declares how many gestures of each class (`pointer`, `key`, `wheel`) it can
synthesize itself — a `browser_click` produces one pointer event, a
`browser_type` one key event per character — and input within that budget is the
agent's own echo. Anything beyond it is a person taking over: the epoch moves,
and a call that settles under a different epoch than it started returns
`interrupted_by_human`, which the harness sees in the tool result.

Toolbar back/forward/reload and an address-bar navigation are human gestures.
Observed navigation is reported as a passive `location` input, which never marks
human control — otherwise the agent's own navigations would look like a
takeover.

Teardown runs off `thread.deleted` / `thread.archived`, because the engine is
the only writer of durable thread state.

---

## 11. The terminal

Each thread has a terminal drawer at the bottom of its column: real shells,
running on the server in the thread's project folder, shown in xterm.

### Opening one

`Cmd+J`, the palette's "Toggle terminal" and the "Terminal" button on the strip
the closed drawer collapses to, at the bottom of the thread column
(`terminal-bar.tsx`), all fire the same command, `terminal.toggle`; the open
drawer's own "Hide terminal" button closes it. The command is answered by
`ThreadTerminal` (`apps/web/src/components/terminal/terminal-drawer.tsx`),
which is always mounted with the thread view, so the button and the chord take
one path — the one that also moves focus into the terminal it opens. Whether a
thread's drawer is open, and how tall the drawer is, is presentation state in
localStorage (`apps/web/src/state/terminal-ui.ts`). The drawer is at least
120px tall and at most 70% of the column, and never so tall that the
conversation above it gets less than 120px: the header and composer keep their
height, so the drawer measures them (`use-drawer-bound.ts`) and is shown at the
stored height or that bound, whichever is lower — the way the dock always
leaves the thread column its minimum width, even after the window shrinks. On
a window too short for both floors the drawer keeps its 120px, and the xterm
fits the rows it can show.

A drawer that opens with no terminals starts one, once `terminal.list` has
said there are none and the xterm has measured the grid to start it at. The
client mints the `TerminalId`, so `terminal.open` is idempotent: a repeated
open answers the shell already running under that id instead of starting a
second one. The New tab button is disabled at `TERMINALS_PER_THREAD` (8), its
tooltip saying so, and the server refuses a ninth with `conflict`; an exited
terminal still counts until it is closed. A long tab title shrinks, truncating,
before the strip overflows, though never so far that "Terminal 3" loses its
number; past that the strip scrolls sideways, fades at an edge with more tabs
beyond it, and turns a vertical mouse wheel into a sideways scroll.

On the server, `TerminalService` (`apps/server/src/terminal/TerminalService.ts`)
asks `workspaceOf` for the directory: the thread's workspace root from
`threadWorkspaceRoot` — its worktree when it has one, its project's folder
otherwise — refused as `not-found` for a deleted thread, and as `invalid` for
an archived one or a folder that no longer exists on disk. The shell comes from `resolveShell` in
`apps/server/src/terminal/shell.ts`: `$SHELL` when it is an absolute path,
else `/bin/zsh` on macOS and bash (or `sh`) on Linux, with `-l` so it reads the
user's profile — an app launched from the Finder has only launchd's bare
`PATH`, and a login shell is what gives it the one the user sees in their own
terminal. On Windows it is `COMSPEC`, else `powershell.exe`. `terminalEnv`
starts from the server's environment and takes out what belongs to OpenAde:
`ELECTRON_RUN_AS_NODE`, which the desktop app sets to run the server under its
Electron binary and which would turn every Electron-based CLI started from the
shell into plain Node, and every `OPENADE_*` key. Under an AppImage it also
removes the AppImage runtime's variables and its mount point's entries from the
search paths. It sets `TERM=xterm-256color`, `COLORTERM=truecolor` and
`TERM_PROGRAM=OpenAde`, and on macOS an unset `LANG` becomes `en_US.UTF-8`.

`apps/server/src/terminal/pty.ts` starts the shell in a pseudo-terminal through
`@lydell/node-pty`, loaded on the first spawn rather than at boot. A module that
fails to load makes that open fail `unavailable` ("terminal support failed to
load: …") and is tried again on the next one; the rest of the server never
notices. A shell that cannot be started fails `internal`, naming the file.

`terminal.write` runs whatever it is sent in the user's shell. It rides the
same loopback, token-authenticated WebSocket that already accepts
`orchestration.dispatch`, so it exposes nothing that socket did not already
reach.

### Output

Everything the shell prints takes one path, synchronous inside the pty's data
callback (`apps/server/src/terminal/session.ts`). The batcher
(`batcher.ts`) holds output for `TERMINAL_BATCH_MS` (16ms) after the first
chunk, or sends at once when a batch reaches `TERMINAL_BATCH_CHARS` (64K
chars), so a shell writing a byte at a time is not a frame per byte; a batch
never ends between the halves of a surrogate pair. Each batch is appended to
the scrollback first and then published on the terminal's hub with the
scrollback's new `offset` — the total number of chars the terminal has ever
produced.

The scrollback (`scrollback.ts`) keeps the last `TERMINAL_SCROLLBACK_CHARS` (1M
chars). Past that the oldest output goes, and what remains starts after its
first newline, so a replay begins at the start of a line rather than in the
middle of an escape sequence. It lives in memory only.

`terminal.subscribe` sends a `snapshot` first — the terminal's summary, its
scrollback and that scrollback's offset — then live `output`, then `exited`
when the shell ends, and then the stream ends. The server subscribes to the hub
_before_ it reads the scrollback, so output written in between is in both, and
drops any `output` at or below the snapshot's offset; read the other way round,
it would be in neither. A subscriber that falls behind its budget
(`TERMINAL_STREAM_BUDGET_ITEMS` 4096, `TERMINAL_STREAM_BUDGET_BYTES` 4 MiB) is
sent `resnapshot-required` instead of a growing backlog. Terminal output is
never merged the way timeline items are: every item is a boundary.

On the client, `terminalAttachAtom` (`packages/client-runtime/src/terminalAtoms.ts`)
hands every item to a callback in order. It is a callback-running
`runtime.fn`, not an atom over the stream, because an atom built from a stream
keeps only the last item of each chunk, and a terminal that loses a chunk of
output paints garbage. It subscribes again after `resnapshot-required` or a
dropped socket, treats the end after `exited` as final, and turns a server
`not-found` into a client-only `gone`. The xterm
(`apps/web/src/components/terminal/terminal-view.tsx`, fed by
`terminal-feed.ts`) resets to each `snapshot` and drops output the snapshot
already holds. xterm parses writes from a queue that `reset()` leaves alone, so
the reset waits until everything written before the snapshot has been parsed;
otherwise output the old subscription had queued would land on the fresh
screen above the snapshot. Items arriving meanwhile are held and written after
it. Until the queue has drained and the snapshot has been parsed, the xterm's
own answers are not sent: the old output and the replay contain the shell's old
terminal queries (colours, cursor position), and xterm would otherwise answer
each of them to the shell as fresh input. The user's keys and pastes come out of
the same `onData` and are still sent; the feed tells them apart by shape, since
each answer is one whole report sequence of the few kinds xterm sends
(`isTerminalReport`).

Input goes through one lane per terminal, so keys typed while a write is in
flight follow it in order as the next write, split at `TERMINAL_WRITE_MAX_CHARS`
if a paste is larger. A write that fails takes with it the input queued behind
it when it left, the rest of a split paste above all, so that never reaches the
shell later with the next key; a terminal answered `not-found` drops its whole
lane. The xterm fits itself to the drawer and sends a resize, debounced by
100ms and only when the grid changed; only the latest pending size is sent.

The theme is read from our own tokens at runtime
(`apps/web/src/components/terminal/terminal-theme.ts`): background,
foreground, cursor and selection are resolved to RGBA through a 1×1 canvas,
because the tokens are `oklch(…)` and xterm cannot parse that, and are read
again when the theme changes. The block cursor is the foreground with the
character under it in the background, so the character stays readable. The 16
ANSI colours stay xterm's own palette, which is tuned for a dark background;
xterm's `minimumContrastRatio` (4.5, WCAG AA) lifts any of them too faint
against the background as it draws, so white and bright yellow stay readable
on the light theme.

### Reattaching

A terminal outlives its subscribers. Switching threads unmounts the drawer:
the xterm is disposed and the subscription ends, but the shell keeps running.
The tabs are kept in memory per thread (`drawer-state.ts`, in a `keepAlive`
map), and the drawer's open state is in localStorage, so coming back shows the
same tab in front, and the new subscription starts with a snapshot of
everything the shell printed meanwhile, up to the scrollback bound. A reload
works the same way, from `terminal.list`. A server restart ends every shell:
the listing comes back empty, the attach reports `gone`, and the tab drops.

The drawer shows the tab in front in an xterm of its own; switching tabs
disposes it and starts a fresh one from the other terminal's snapshot, so
output still queued for the old xterm, and xterm's answers to queries in it,
never reach the other terminal. An exited
terminal stays listed, marked "exited", with its final output, until it is
closed, so the last thing a command printed is still readable.

### Teardown

A shell ends on `terminal.close` — closing a tab, and closing the last tab
hides the drawer — on `thread.deleted` and `thread.archived`, which the service
watches on the engine's event stream the way the browser pane's teardown does,
and when the server shuts down. Killing is bounded: SIGHUP, what a closing
terminal sends, then after one second SIGKILL to the shell, to every process
under it and to every process group they are in, and at most two seconds more
waiting for the exit (the `ps` read below is bounded at two seconds too). The
shell has job control on, so each job runs in a group of its own and SIGKILL to
the shell's group alone would miss it; the processes under the shell come from
one `ps -A -o pid=,ppid=,pgid=` read while the shell is still alive (`apps/server/src/terminal/reap.ts`), since once it dies its jobs
are re-parented to init and nothing ties them to it. The kill cannot be
interrupted: `terminal.close` takes the terminal out of the registry before
killing it, so a client that cancels the call or disconnects during the grace
second would otherwise leave a shell that ignores SIGHUP with nothing left to
reach it. A shell that obeys SIGHUP
passes it on to its jobs itself; a job started with `nohup` keeps running, as
it would after closing any terminal.

### Keys, links, find and quoting

While a terminal has focus, the one keybinding listener considers only
`terminal.toggle` and leaves every other chord to the shell (§12), so `Escape`
reaches vim rather than interrupting the turn. The xterm refuses the toggle's
own chord through `attachCustomKeyEventHandler`, so it bubbles to that listener
instead of reaching the shell — off macOS `Ctrl+J` would otherwise be a line
feed.

A printed http(s) link opens on a mod-click (`Cmd` on macOS, `Ctrl`
elsewhere) and nowhere else: a plain click in a terminal places the selection.
It opens in the thread's own browser pane — the dock switches to its Browser
tab and the pane is sent a human `navigate`, as its address bar would send
(`use-open-link.ts`, `terminal-links.ts`).

Find is a row under the drawer's toolbar (`terminal-find.tsx`) that searches
the xterm in front as the user types: Enter for the next match, Shift+Enter for
the previous one, Escape to close it and return focus to the terminal. Match
highlights are our foreground mixed into our background, since xterm's search
addon takes only opaque `#rrggbb`.

"Add selection to chat" quotes the terminal's selection into the thread's
composer draft (`appendQuotedBlock` in `apps/web/src/lib/quote-selection.ts`):
the padding xterm adds to each selected line and any blank lines around the
text are trimmed, each line gets `> `, and a blank line separates the block
from text already in the draft and from what the user types next. It writes
the per-thread draft the composer renders from, then moves focus to the
composer's input with the caret after the quote, so the user can type the
question straight away.

---

## 12. Settings

### The document

Settings are server-owned. The renderer reads them with `settings.get`, watches
`settings.subscribe`, and patches with `settings.update`, so a change made in
one window shows up in the other. The schema is
`packages/contracts/src/settings.ts`; the store is `SettingsStore` in
`apps/server/src/rpc/services.ts`, which persists the whole document as one
JSON row in the `settings` table.

```
Settings
  connectors         ConnectorInstanceConfig[]  id, kind, displayName, enabled, config
  defaults           { model, effort, runtimeMode }
  theme              system | light | dark
  keybindings        Keybinding[]               the user's overrides on DEFAULT_KEYBINDINGS
  keybindingsFormat  "overrides"                absent on a document from before overrides
  permissions        PermissionRule[]           a projection of the permission_rules table
  git                { branchPrefix }           what a new worktree's branch starts with
  projectSettings    { [projectId]: { setupScript? } }
```

`git` and `projectSettings`, like the two font sizes, are defaulted on decode
(`openade/` and `{}`), so a row written before they existed still reads.

Both are edited on the Git & worktrees page. The branch prefix saves on blur,
Enter or Save, trimmed, and only when it changed; a prefix git would refuse
(a leading `-` or `/`, spaces, `..`, `@{`, `~^:?*[\`) is named under the input
and not saved, though `git.worktree.create` still has the last word. A setup
script is saved per project, but a patch replaces the whole key, so the page
writes the whole `projectSettings` record, rebuilt from the latest document at
the moment of the click (`apps/web/src/components/Settings/git-settings.ts`):
editing one project keeps every other project's script, and a blank script
removes the project's entry.

Every field carries a `settingsForm` annotation — label, description, control —
so the settings pages render from the schema and cannot drift from it. A
connector's `config` is its own document: the connector's definition owns the
schema, annotates its fields the same way, and the server describes the
resulting form (with the connector's name, icon key and docs link) over
`connectors.describe`. A new connector needs no connector-specific markup and
no change to the contracts package.

`permissions` is a projection, not a second store: the `permission_rules` table
is the single source of truth, and a settings update that carries a
`permissions` array replaces the table wholesale, because editing the list in
the UI is a whole-document operation.

The whole document is written at once, so `update` holds a mutex — a
read-modify-write that yielded in the middle would lose the other writer's
fields entirely.

### Keybinding defaults

`DEFAULT_KEYBINDINGS` in `packages/contracts/src/keybindings.ts`. An empty
"when" means the binding holds everywhere. A command marked "(inert)" is bound
but nothing answers it yet, so its chord does nothing and the palette does not
list it.

| area     | command                                               | shortcut                      | when                                                               |
| -------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| General  | `commandPalette.toggle`                               | `Mod+K`                       |                                                                    |
| General  | `shortcuts.open` (inert)                              | `Mod+/`                       |                                                                    |
| General  | `settings.open`                                       | `Mod+,`                       |                                                                    |
| General  | `skills.open`                                         | `Mod+Shift+S`                 |                                                                    |
| General  | `mcp.open`                                            | unbound                       |                                                                    |
| General  | `project.add`                                         | `Mod+Shift+O`                 |                                                                    |
| Threads  | `thread.new`                                          | `Mod+N`                       |                                                                    |
| Threads  | `thread.newInProject` (inert)                         | `Mod+Shift+N`                 |                                                                    |
| Threads  | `thread.jump.1` … `thread.jump.9` (inert)             | `Mod+1` … `Mod+9`             |                                                                    |
| Threads  | `thread.previous` / `thread.next` (inert)             | `Mod+Shift+[` / `Mod+Shift+]` |                                                                    |
| Threads  | `thread.rename` (inert)                               | `Mod+Alt+R`                   | `threadOpen`                                                       |
| Threads  | `thread.archive` (inert)                              | `Mod+Shift+A`                 | `threadOpen`                                                       |
| Threads  | `thread.delete` (inert)                               | `Mod+Alt+Backspace`           | `threadOpen`                                                       |
| Threads  | `nav.back` / `nav.forward` (inert)                    | `Mod+[` / `Mod+]`             | `!browserFocus`                                                    |
| Composer | `composer.planMode.toggle`                            | `Shift+Tab`                   | `composerFocus`                                                    |
| Composer | `composer.runtimeMode.cycle`                          | `Mod+Shift+L`                 |                                                                    |
| Composer | `composer.modelPicker.open`                           | `Mod+Shift+M`                 |                                                                    |
| Composer | `composer.effortPicker.open`                          | `Mod+Shift+E`                 |                                                                    |
| Composer | `composer.effort.increase` / `decrease`               | `Mod+Shift+.` / `Mod+Shift+,` |                                                                    |
| Composer | `composer.focus`                                      | `Mod+L`                       | `!browserFocus`                                                    |
| Composer | `composer.queue`                                      | `Mod+Enter`                   |                                                                    |
| Composer | `thread.interrupt`                                    | `Escape`                      | `turnRunning && !dialogOpen && (inputFocus \|\| !approvalPending)` |
| Composer | `composer.attach`                                     | `Mod+U`                       |                                                                    |
| Composer | `composer.clearDraft`                                 | `Mod+Shift+Backspace`         | `composerFocus`                                                    |
| View     | `sidebar.toggle`                                      | `Mod+B`                       |                                                                    |
| View     | `dock.toggle` (inert)                                 | `Mod+Alt+B`                   | `threadOpen`                                                       |
| View     | `dock.changes` / `dock.files` (inert)                 | `Mod+Shift+D` / `Mod+P`       | `threadOpen`                                                       |
| View     | `browserPane.toggle`                                  | `Mod+Shift+B`                 |                                                                    |
| View     | `terminal.toggle`                                     | `Mod+J`                       |                                                                    |
| View     | `font.increase` / `decrease` / `reset` (inert)        | `Mod+Alt+=` / `-` / `0`       |                                                                    |
| Timeline | `timeline.jumpToLatest` (inert)                       | `Mod+Shift+J`                 | `threadOpen`                                                       |
| Timeline | `timeline.collapseAll` / `expandAll` (inert)          | `Mod+Alt+[` / `Mod+Alt+]`     | `threadOpen`                                                       |
| Cards    | `approval.allowOnce` / `allowSession` / `allowAlways` | `1` / `2` / `3`               | `approvalPending && !inputFocus && !dialogOpen`                    |
| Cards    | `approval.deny`                                       | `D`, `Escape`                 | the same                                                           |
| Cards    | `plan.accept` / `acceptAndRun` / `revise`             | `1` / `2` / `3`               | `planPending && !inputFocus && !dialogOpen`                        |
| Cards    | `question.option.1` … `question.option.9`             | `1` … `9`                     | `questionPending && !inputFocus && !dialogOpen`                    |

Enter sends and Shift+Enter inserts a newline. In the `/` and `@` menus,
Up/Down or Tab/Shift+Tab move, Enter picks and Escape closes. These keys are
not in the table, because they depend on the menus and on IME composition, so
the composer's own key handler keeps them (`composer-keys.ts`). The command
catalog lists them as `FIXED_KEYS`, for display only.

The chords stay clear of the macOS system shortcuts, the Electron default menu
and the standard text-editing chords. The app sets no application menu, so the
Electron default one is live: Mod+R reloads, Mod+=/-/0 zoom, Mod+W closes. Font
size therefore uses `Mod+Alt+=`/`-`/`0`. When macOS Accessibility zoom is
turned on (it is off by default), it takes those same chords first.

`RESERVED_KEYBINDINGS`, in the same module, holds chords for features that are
still being built, so that nothing ships on them first. Nothing dispatches
these rows. They exist so the collision test can treat each one as a binding.

| command            | shortcut          | when           | for                                   |
| ------------------ | ----------------- | -------------- | ------------------------------------- |
| `git.commit`       | `Mod+Alt+C`       |                | Commit the staged changes             |
| `git.push`         | `Mod+Alt+P`       |                | Push the current branch               |
| `git.branchPicker` | `Mod+Shift+G`     |                | Open the branch picker                |
| `browser.focusUrl` | `Mod+L`           | `browserFocus` | Focus the browser pane's address bar  |
| `browser.reload`   | `Mod+R`           | `browserFocus` | Reload the page instead of the window |
| `browser.back`     | `Mod+[`           | `browserFocus` | Go back in the browser pane           |
| `browser.forward`  | `Mod+]`           | `browserFocus` | Go forward in the browser pane        |
| `composer.steer`   | `Mod+Shift+Enter` |                | Steer the running turn with the draft |

Two further rules reserve keys without a row:

- Chords scoped to `terminalFocus` are the terminal's to choose. They still
  have to pass the collision test.
- `@`, `#`, `$` and `/` are characters that the composer's triggers read, so
  they are never bindings.

Features that are still being built need to know two things:

- A focused `<webview>` never delivers key presses to the host window, so the
  browser pane must route them through the `before-input-event` relay in
  `apps/desktop/src/main/ipc.ts`.
- `browser.reload` must stop the default menu's reload from also firing.

`packages/client-runtime/src/default-keymap.test.ts` locks the table. It fails
the build, on either platform, in these cases:

- two defaults share a physical chord in contexts that can overlap;
- a default collides with a reserved row;
- a default takes a system-reserved chord;
- Tab, Enter, Space or a plain arrow is bound without a clause that names a
  focus key;
- anything plain or Shift-only is bound on a trigger character;
- a shortcut or a clause fails to parse.

Every command has an entry in `COMMAND_CATALOG`
(`apps/web/src/lib/command-catalog.ts`). The entry holds the command's title,
its area (General, Threads, Composer, View, Timeline or Cards), an optional
description and icon, and a `palette` flag. Commands with no default chord,
such as `mcp.open`, have entries too. A test fails when a default command has
no entry. Labels show a command's chord with `CommandKbd command="…"`, which
reads the effective table, so a hint always shows the key the user actually
bound.

The matcher is `packages/client-runtime/src/keybindings.ts`:

- **Notation.** `Mod` is the platform modifier: Meta on macOS and iOS, Ctrl
  elsewhere, so one stored binding works on every keyboard. `Cmd` and `Meta`
  are aliases of it, so a table stored as `Cmd+…` keeps working, and the
  recorder writes `Mod+…`. `Ctrl` always means the physical Control key.
- **Exact modifiers.** `Escape` does not fire on `Shift+Escape`, and `Mod+K`
  does not fire on `Mod+Alt+K`.
- **Layout-safe keys.** With Alt or Shift held, `event.key` is often not the
  key's own character: macOS Option+R reports `®`, Shift+[ reports `{`. So a
  chord with Alt or Shift also matches on the key `event.code` names (`KeyR` →
  `r`, `BracketLeft` → `[`), and the recorder writes that key, storing
  `Mod+Alt+R` rather than `Mod+Alt+®`. A reported letter or digit is trusted as
  it is, so on AZERTY a chord on A does not fire on the key at `KeyQ`.
- **AltGr.** A press where AltGr is typing a character resolves to nothing
  (`isAltGraphTyping`): the event reports the AltGraph modifier, or, off macOS,
  Ctrl and Alt are held and the key typed a printable character that is not its
  own. AltGr+C typing `ć` on a Polish layout never fires `Mod+Alt+C`.
- **`when` clauses** read context flags with `!`, `&&`, `||`, parentheses and
  `==`/`!=`. An unknown flag is false, and an unparseable clause disables its
  binding rather than misfiring.
- **The text-field rule.** While `inputFocus` is true, a binding fires only if
  its chord has Mod or Ctrl, its key is Escape or F1–F24, or its `when` clause
  names a focus key (`inputFocus`, `composerFocus`, `terminalFocus`,
  `browserFocus`). A plain key, Shift+key, Alt+key, Tab, Enter or an arrow
  never fires while the user is typing unless its clause says where it applies,
  as `Shift+Tab` with `when: composerFocus` does (`firesInTextField`).

The context keys a clause may name are listed, with what each means and who
sets it, in `KEYBINDING_CONTEXT_KEYS` (`packages/client-runtime/src/keymap.ts`).
The listener computes `inputFocus`, `composerFocus`, `terminalFocus`,
`browserFocus`, `dialogOpen` and `isMac` from the keypress; components publish
`threadOpen`, `dockOpen`, `turnRunning` (`threadRunning` is an alias),
`approvalPending`, `questionPending` and `planPending`. `CONTEXT_AXIOMS`
records what always holds between them: `composerFocus` and `terminalFocus`
each imply `inputFocus`; focus is in at most one of the composer, the terminal
and the browser; at most one of an approval, a question and a plan is pending;
`isMac` is fixed per platform.

Conflicts are found by the same module, per platform
(`findKeybindingConflicts`). Two rows for different commands conflict when they
are the same physical chord on that platform — off macOS `Mod+K` and `Ctrl+K`
are the same keys, on macOS they are not — and their contexts can hold at
once. Each row's context is its clause plus the implicit `!inputFocus` the
text-field rule adds to a plain chord; `whenOverlaps` decides by brute force
over the flags both clauses name, skipping assignments the axioms rule out, so
`1` for an approval and `1` for a plan never conflict, and neither conflicts
with a `1` bound only in the composer. A `x == "v"` comparison counts as an
independent flag, which can only report more conflicts, never fewer.
`SYSTEM_RESERVED_CHORDS` lists, per platform and with a reason, the chords the
operating system, the text system or the Electron default menu already owns —
quit, close, hide, reload, devtools, zoom, the editing and text-navigation
chords, and on macOS the Cocoa `Ctrl+letter` editing keys — and
`reservedChordReason` looks one up.

The context for each press is built by `apps/web/src/lib/keybinding-context.ts`:
`focusSnapshot` reads whether the focused element is a text field, its closest
`data-context` (`composer`, `terminal`, `browser`) and whether a dialog,
alert, menu, menubar or listbox is on screen; `keybindingContext` answers the
built-in keys from that snapshot and the platform, and every other key from the
registry under its canonical name, so an older stored clause naming
`threadRunning` still reads `turnRunning`. A component cannot publish a
built-in key. Who publishes the rest:

| key                                                 | published by                                    |
| --------------------------------------------------- | ----------------------------------------------- |
| `threadOpen`, `dockOpen`                            | `ThreadView`, while mounted / while the dock is |
| `turnRunning`                                       | `Composer`                                      |
| `approvalPending`, `questionPending`, `planPending` | `PendingCard`, for exactly the card it shows    |

There is exactly one listener, mounted at the app root
(`apps/web/src/lib/shortcuts.tsx`). It runs in bubble phase so focused controls
get first refusal and it skips `defaultPrevented`, repeated, IME-composing and
AltGr-typing events — the composer's trigger menu eats `Escape` before it
arrives, so the global table only ever sees what nothing closer to the focus
wanted. The interaction cards' keys are table rows like any other (§5, §6),
kept apart from each other and from `thread.interrupt` by their `when` clauses,
not by listening first. A focused terminal goes further: inside
`[data-context="terminal"]` the listener only considers `terminal.toggle` and
leaves every other chord to the shell without calling `preventDefault`, so
`Escape` reaches vim instead of interrupting the turn, and `Mod+K` and `Mod+B`
reach the program running there (`yieldsToTerminal` in
`apps/web/src/lib/keybindings.ts`). A surface that owns a command registers a handler
while it is mounted, and a surface that is not mounted does not answer its
command: `thread.interrupt` belongs to the composer, so it is inert on the
settings page rather than reaching into a thread nobody is looking at.
Registration is a stack per command id, so two surfaces claiming the same id
hand it back in order instead of blanking it
(`apps/web/src/lib/command-registry.ts`).

The settings document stores only the user's overrides, never a copy of the
defaults — a copy would pin an install to the keymap of the build that wrote
it, and a shortcut added later would never reach it. The rule is per command
(`resolveKeymap` in `packages/contracts/src/keybindings.ts`):

- When the overrides mention a command at all, its default rows are dropped and
  its override rows are its bindings.
- A `-X` row (VS Code's convention) mentions `X` without binding it, so on its
  own it unbinds `X`. Its shortcut is the chord it removed, kept for display.
- The effective table is the override rows first, then the defaults of every
  command the overrides do not mention. Resolution is first-match, so an
  override shadows another command's default on the same chord.
- An override for a command no default names is kept, and is inert until
  something registers that command.

So an empty list means "every default", and it is what a fresh install writes.
The editor shows and edits the effective table, and Save posts
`diffKeymap(DEFAULT_KEYBINDINGS, draft)`: a command left at its default stores
nothing and keeps following the defaults, and a command whose last row was
removed is stored as `-X` and stays unbound.

`keybindingsFormat: "overrides"` marks a document written this way. A document
without it is from before overrides and holds the whole keymap of its build.
Such a table was brought up to that build's keymap once by the
`0006_terminal_keybinding` migration, which appends `terminal.toggle` →
`Cmd+J` where neither the command nor the chord was taken, so the frozen copy
ends with that row. `SettingsStore`'s load migrates it (`migrateLegacyKeybindingTable`, comparing
against a frozen copy of that old keymap): a command still bound exactly to its
old default gets no override and follows the defaults from now on, one missing
from the table gets a `-X` row, one with different rows keeps them, and rows for
any other command are kept as they are. The first write persists the migrated
form with the marker; until then the same row migrates to the same answer on
every start. The `keybindings.get`/`update` RPCs kept their shape, so there was
no protocol bump — an older server's full table still resolves to the same
keys, because each of its rows replaces only its own command's defaults.

### Connector instances

`ConnectorManager` treats the settings document as desired state and the
registry's open instances as actual state. A new or edited entry is probed —
always, because the connectors page wants binary state even for a disabled
instance — and opened when enabled; a toggled one is closed or reopened; a
removed one's scope is closed, which deregisters it. `connectors.list` answers
from the last reconcile's probes, and `refresh: true` reconciles and re-probes,
which is what the page's probe button and every save do. A probe gets 15 s
before it is reported as an error.

Routing follows the settings document's order, not the order instances happened
to be opened in — the same reading a new thread's default model is seeded from,
so the two can never name different instances. That order is the fallback: a
thread that chose its instance runs on it, and is seeded from its default or
first model, while it is open.

### The CLI's own config files

Two files in the user's own space are written by OpenAde, both marked and both
put back.

**`<workspaceRoot>/.commandcode/settings.local.json`** gets the PreToolUse hook
block while a session is open (`packages/connector-cmd/src/config.ts`):

```json
{ "matcher": ".*", "hooks": [{ "type": "command", "command": "<hookPath>", "timeout": 590 }] }
```

The merge preserves every other key and every other hook entry. Ownership is
decided per _hook command_, so a user hook sharing an entry with ours survives
removal. Teardown is guarded twice: the install records the hash of the bytes it
wrote and reverts only while the file still hashes to that, and a per-path
retain count keeps the first session to close from pulling the hook out from
under a second session in the same project. While the block is in place, a
line in the repository's `info/exclude` keeps the file out of `git status` and
of every commit — the hook it names is this machine's — and the teardown takes
that line out again. A file that exists but is not strict JSON is never
rewritten — the session runs without the gate and says so.

**The local MCP scope** gets an `openade` entry. That file lives at
`~/.commandcode/projects/<slug>/mcp.json`, and the slug is a private rule the
CLI owns, so **the CLI writes it**: `cmd mcp add-json --scope local`, and `cmd
mcp remove` to take it back. Writing it ourselves put the entry beside the
directory the harness reads whenever the workspace path has a camel hump or an
underscore in it, which silently offered the model no browser tools at all in
those projects. The entry is removed by name, so a server the user added under
any other name is untouched.

The Customize page edits a different pair of files through the connector's
MCP servers extension (`packages/connector-cmd/src/mcpServers.ts`):
`~/.commandcode/mcp.json` for user scope and `<workspaceRoot>/.mcp.json` for
project scope. The page asks by instance id — `connectors.mcp.list`, `.add`,
`.remove` — and `apps/server/src/settings/ConnectorExtensions.ts` finds the open
instance, turns the `projectId` into its workspace root and calls the
extension; an instance without it answers `unavailable`, and the page shows a
section only for the enabled instances whose `ConnectorSummary.extensions` says
they have one. Ownership there is per entry — every server OpenAde writes
carries an `_openade` marker — and add/remove refuse to touch an entry without
it. Disabling is a move, not a
flag: Command Code launches everything under `mcpServers` and ignores keys it
does not know, so a disabled server's definition is parked verbatim under
`_openadeDisabled`. A file that cannot be parsed is never rewritten; listing
reports no servers for it and writes fail with a `conflict` naming the file,
because a rewrite would be built from an empty base and would delete every
server the user hand-authored.

**Skills** are discovered, not written: the skills extension
(`packages/connector-cmd/src/skills.ts`), asked through `connectors.skills.list`,
walks `~/.commandcode/skills` and `<workspaceRoot>/.commandcode/skills`, reads
the `name` and `description` out of each `SKILL.md` frontmatter, and lets a
project skill win a name collision, matching the harness's own precedence. The
composer's `/` popover asks the thread's own instance for that list. The one
write is a link: `connectors.skills.available` lists the skills in
`~/.agents/skills` the instance does not load yet, and `connectors.skills.link`
symlinks one into `~/.commandcode/skills`. Those homes follow the instance's
`extraEnv.HOME` when it sets one, since that is the home the CLI resolves.

**Plugins** have an extension of their own, read-only, for a harness that has
them: `connectors.plugins.list` answers each installed plugin's name,
description, source, scope and whether it is enabled. Command Code has no
plugins, so its instance answers `unavailable`, and the client runtime's
`pluginsAtom` reads that as an empty list rather than an error.

---

## 13. Crash and recovery

### A session that dies

A child that dies on a signal nobody asked for ends the session with reason
`crashed` (`packages/connector-cmd/src/session.ts`), and a session whose event
stream simply ends is treated the same way — the process is gone either way
(`SessionManager`). `makeSessionSupervisor`
(`apps/server/src/orchestration/SessionSupervisor.ts`) watches the lifecycle
channel and, on `crashed`:

1. appends a visible `thread.error` — "the agent process exited unexpectedly;
   reconnecting" — because without it the answer just stops mid-sentence;
2. runs the resume loop: `SessionManager.ensure` with the persisted
   `sessionRef`, up to 4 attempts with a 250 ms base delay doubling per
   attempt;
3. writes `thread.session.lost` when the attempts run out.

A `stopped` end is deliberate and restarts nothing.

`thread.session.bound` landing while a turn is still in flight means a resume:
the reactor re-sends the turn, and the turn-scoped handle dedupes a turn it
already has, so the fresh-session path costs nothing.

### Resuming the harness

Continuing a conversation means handing the next process `--session <id>`. The
persisted `CmdSessionRef` is `{ sessionId, transcriptPath, cwd, lastMessageId }`.

A run killed by SIGINT never writes its transcript, so the id its `run_start`
announced names a session that no longer exists:

```
Error: --session "<id>" is neither an existing .jsonl transcript nor a known session-id prefix.
```

and the next spawn exits 1 before emitting a frame. Pressing Stop therefore used
to break a thread permanently. `packages/connector-cmd/src/sessionRef.ts` asks
the filesystem the same question the harness asks before it builds an argv, and
continues in a **new** session with a `session.warning` when there is no
transcript to resume.

A resumed session also catches its translator up before its first turn: it folds
the transcript up to `lastMessageId` without emitting anything. Everything after
that marker is work nobody has been shown and the tailer delivers it; everything
before is history. Without the marker the `run_end` reconcile would re-emit the
whole conversation with fresh item ids.

### A server that restarts

At layer build, the supervisor scans the thread read model **inline** — at real
boot the database is the only state that exists, so "running with no session"
genuinely means lost, and forking the scan would let live dispatches interleave.
A thread that is running or waiting with no `sessionRef` gets
`thread.session.lost` immediately; one with a `sessionRef` gets a resume loop on
its own fiber, so a slow connector does not hold the build.

The renderer's half is §2: a changed `serverInstanceId` discards every cached
snapshot, because the new instance never issued the sequence numbers the old
ones are positioned at.

Terminals do not come back. Their shells died with the old process and their
scrollback was only ever in its memory, so the drawer's tabs drop out on the
next `terminal.list` and a terminal still attached reports `gone` (§11).

### Projections

`threads.doc_json` holds a `ThreadDoc` with no schema of its own, so the engine
stamps the `PROJECTOR_VERSION` that wrote each set of rows. At boot, a mismatch
throws the projections away and re-folds every stream from the event log inside
one transaction. The log is the source of truth, so a rebuild is always safe —
and a stale document is never served.

Migrations are numbered, contiguous from 1, and never edited once merged; a
lineage test enforces both. `0005_events_type_index` exists because the
checkpoint reactor's boot replay used to schema-decode every thread event ever
written _before_ the handshake, and the supervisor kills a child that has not
handshaken in 15 s — a large enough log made the app permanently unstartable
over data that was perfectly intact.

### An unreadable settings row

A settings row that no longer decodes does not take the app down. `load` in
`apps/server/src/rpc/services.ts` serves `defaultSettings()` and keeps the raw
text. The first write that replaces the row copies the old text into a
`settings.unreadable` row **in the same transaction** — the write that destroys
the undecodable document is exactly when the copy has to become durable.

---

## 14. Shutdown

Quitting is held open on purpose (`apps/desktop/src/main/quit.ts`):

```
before-quit
  │ preventDefault(); hide the windows
  ▼
ServerSupervisor.stop()      SIGINT to the child, SIGKILL after 5s
  │                          resolves when the child is really gone
  ▼                          (or after the injected deadline, whichever first)
app.exit()
```

`quit.ts` is Electron-free and takes the deadline as a dependency; the value it
is given is `QUIT_DEADLINE_MS` = 15s, declared and passed in
`apps/desktop/src/main/index.ts`.

Signalling and walking away used to leave the server reparented and still
running — it closes sessions one at a time, each spawning `cmd mcp remove` — and
holding `~/.openade/state.sqlite` against the next launch. A second quit while
the app waits falls straight through to Electron, so a wedged server cannot make
the app unquittable.

On the server side, closing `boot`'s scope shuts everything down. Three
finalizers matter — the sockets', the sessions' and the terminals':

- the WebSocket sockets are destroyed first. `http.Server.close()` waits for
  every open connection to end by itself, and a WebSocket never does, so a
  server with a renderer attached would otherwise never finish closing.
- `SessionManager` closes every open session. Session driver scopes are
  free-standing — a session outlives the command that started it — so nothing
  used to close the ones still open at shutdown, and their finalizers never
  ran: every server exit left the hook block and an `openade` MCP entry naming
  a dead port behind, one per session, in files the user owns.

Closing one session is ordered: the handle first, so the connector emits
`session.ended`; then the ingestion fiber's drain, which reports the real
reason; then the scope. Closing the scope first would interrupt the drain,
report `crashed`, and have the supervisor resurrect a session that was
deliberately stopped. A connector whose event stream outlives its close gets
5 s before the scope is closed under it.

`TerminalService`'s finalizer ends every open terminal, all at once: it refuses
new opens from then on, and kills each shell the way closing its tab does —
SIGHUP, then SIGKILL to the shell and everything under it after a second, each
wait bounded — so no shell or job started from one outlives the server and a
wedged pty cannot hold the shutdown up.

---

## Where to look next

| area                                   | start here                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pieces, one by one                 | [architecture.md](architecture.md)                                                                                                                                   |
| the rules and where they are enforced  | [philosophy.md](philosophy.md)                                                                                                                                       |
| running, testing, packaging            | [development.md](development.md)                                                                                                                                     |
| the CLI on the far end                 | [command-code-connector.md](command-code-connector.md), [claude-code-connector.md](claude-code-connector.md)                                                         |
| commands, events, read models          | `packages/contracts/src/orchestration.ts`                                                                                                                            |
| the connector-neutral event vocabulary | `packages/contracts/src/runtime.ts`                                                                                                                                  |
| the RPC surface                        | `packages/contracts/src/rpc.ts`                                                                                                                                      |
| the composition root                   | `apps/server/src/boot.ts`                                                                                                                                            |
| the decider                            | `apps/server/src/orchestration/decider.ts`                                                                                                                           |
| the integrated terminal                | `apps/server/src/terminal/TerminalService.ts`, `apps/web/src/components/terminal/terminal-drawer.tsx`                                                                |
| the Command Code session               | `packages/connector-cmd/src/session.ts`                                                                                                                              |
| what the real CLI does                 | `packages/testkit/fixtures/cmd/README.md`                                                                                                                            |
| the product, end to end                | `apps/server/test/e2e/` — eleven scenarios over a real server and a real socket; the ten with a harness run the real CLI (`OPENADE_LIVE_CMD=1`) or a recording of it |
| the same, on Claude Code               | `apps/server/test/e2e-claude/` — the Claude connector's scenarios, replayed, live (`OPENADE_LIVE_CLAUDE=1`) or recorded (`OPENADE_RECORD_CLAUDE=1`)                  |
