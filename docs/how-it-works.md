# How it works

OpenAde is an Electron desktop app that drives the Command Code CLI — an
agentic coding harness that normally runs in a terminal — from a graphical
interface. This document traces what actually happens at runtime, in order,
with the real names of the processes, commands, events, RPC methods and files
involved, and a path into the source for each step.
[architecture.md](architecture.md) describes the pieces themselves,
[philosophy.md](philosophy.md) the rules they keep,
[development.md](development.md) how to run them, and
[command-code-connector.md](command-code-connector.md) what the CLI on the far
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
- the connector registry, seeded with the Command Code definition
  (`packages/connector-cmd/src/definition.ts`), and the `ConnectorManager`
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
  ├─ protocolVersion ≠ PROTOCOL_VERSION (1) → markIncompatible, Stream.never
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
enabled instance per registered definition on a fresh install, then probes it.
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

Exit codes decide the status (`packages/connector-cmd/src/exitCodes.ts`):

| exit   | probe status             | what the user is told                                        |
| ------ | ------------------------ | ------------------------------------------------------------ |
| 0      | `ready`                  | binary path, version, account, model count                   |
| 3      | `not-authenticated`      | not logged in — run `cmd login`                              |
| 10     | `error`, `auth: present` | insufficient credits, with `helpUrl` to the billing page     |
| 1, 4–9 | `error`                  | the sentence from `EXIT_MESSAGES`, plus the harness's detail |

The billing link (`CMD_ACCOUNT_HELP_URL`) and the docs link
(`metadata.docsUrl`, `https://commandcode.ai/docs`) live in
`packages/connector-cmd`, so no connector's domain name is written into the
renderer: it receives the first as `ConnectorProbe.helpUrl` and the second over
`connectors.describe`. `apps/web/src/components/Settings/probe-help.ts` decides
which failures get a link at all — the probe's own `helpUrl`, or else the
connector's docs link for an account-shaped failure — and `connectorReady` insists on
`status === "ready" && auth !== "absent"` — an installed, reachable, signed-out
CLI reports `ready`, and must not read as usable.

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

- a `/` or `@` menu that has rows → **pick** the highlighted one;
- an IME mid-composition, or Shift held → **insert** a newline;
- otherwise → **send**.

`Cmd+Enter` is the `composer.queue` binding: it sends with `queued: true`.
`use-send-draft.ts` uploads any attachments first (a browser `File` has no
filesystem path, so the server must hold the bytes before the command can name
them) and latches so one Enter cannot start two real turns. While a turn is in
flight the send button becomes Queue and a Stop button appears — both read
`turnInFlight` (`apps/web/src/lib/turn.ts`) rather than `currentTurnId`, which
the projection only fills one event later.

The `/` popover offers `/model`, `/effort`, `/mode`, `/plan`, `/default`,
`/clear-draft` and the project's skills. `/clear` is deliberately not offered:
in Command Code it drops the session's context, no command in the union does
that, and binding it to emptying the textarea would throw away the sentence the
user was writing while keeping every token they meant to drop. `@` searches the
project's files through `files.search` and inserts a chip.

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
workspaceRoot)` and then `handle.send(turnId, turn)`.

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
`Attachment (<mime>): <absolute path>` line per staged file.

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
  "Worked for Ns · N tools" disclosure;
- durations come out of the UUIDv7 ids, which carry their creation millisecond
  in the leading 48 bits;
- rows whose `parentItemId` names a task leave the top level and render nested
  inside that task's row.

`apps/web/src/components/timeline/timeline-item.tsx` dispatches one component
per `ItemKind`.

### Closing the turn

`run_end` produces `turn.completed` with a `stopReason` of `end_turn`,
`interrupted`, `error` or `max_turns`. Before the completion event leaves the
session, `session.ts` does the bookkeeping that has to happen while the turn is
still open — once it settles, the engine stops tagging events with its
`turnId`:

1. warn if the gate was silent (tools queued, no hook post — see §5);
2. re-read the transcript, which is where `usage.costUsd` arrives;
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
PermissionService.decide(...)          apps/server/src/permissions/PermissionService.ts
   │
   ├─ allow  → { permissionDecision: "allow" }
   ├─ deny   → { permissionDecision: "deny", reason: "denied by OpenAde permission rules" }
   └─ prompt → emit request.opened, park on a Deferred
                 │
                 │  thread.approval.opened → card in the timeline
                 │  user answers → thread.approval.respond
                 │  → thread.approval.resolved → handle.respondToRequest
                 ▼
               { permissionDecision: "allow" | "deny", reason: "decided <d> via OpenAde" }
```

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
offers four answers. Keys while it is up: `1` allow once, `2` allow for
session, `3` always allow, `d` or `Escape` deny. The card listens in **capture**
phase and stops propagation, so its `Escape` beats the global `thread.interrupt`
binding (§11) while a card is open — denying the call, not stopping the turn.

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

The patterns are Command Code's own syntax — `Shell(npm run *)`,
`Edit(/src/**)`, `mcp__server__tool` and the rest — matched by
`packages/shared/src/permissionPattern.ts` on both sides, so the preview in the
card means what the engine will do. The grammar is in
[architecture.md](architecture.md#permissions); which suggestion a given tool
call produces is in
[command-code-connector.md](command-code-connector.md#the-tool-vocabulary).

### Subagents

PreToolUse fires **once** for an `agent` delegation, with the subagent's brief
as the input, and never again for what the subagent then does. Approving the
delegation approves everything it goes on to do; the prompt in that one payload
is all the user gets to judge. The only visibility into the work is the
`subagent_start` / `subagent_progress` / `subagent_stop` frames, which the
connector maps onto the `task` row the `agent` call opened
(`packages/connector-cmd/src/subagents.ts`).

### When the gate stays silent

The gate's failure mode is to open: a hook that does not run produces no
decision and the harness falls back to its own flow. So the session counts
`tool_queued` frames and hook posts, and a turn that queued tools and received
no post emits a `session.warning` saying so — which the timeline shows as an
error row. Plan mode is exempt, because no hook fires there by design.

---

## 6. Plan mode and questions

### Plan mode

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
the card (`apps/web/src/components/approvals/plan-card.tsx`) offers three
answers. `ProviderCommandReactor` acts on `thread.plan.responded`:

| action        | settings change                                                  | follow-up turn                            |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `accept`      | `interactionMode: "default"`                                     | "Implement the approved plan at `<path>`" |
| `accept-auto` | `interactionMode: "default"`, `runtimeMode: "auto-accept-edits"` | the same                                  |
| `revise`      | `interactionMode: "plan"`                                        | the feedback text, or "Revise the plan"   |

The plan's path travels on the `thread.plan.responded` event rather than in a
reactor's memory: the fold clears `pendingPlan` on that very event, so carrying
it is what lets the accept turn survive a restart between proposing and
accepting.

### Questions

`ask_user_question` is withheld from a headless run, which is why every turn
passes `--tools-enable ask_user_question`. Print mode has no interactive
channel, so the tool call takes the hook road for a different purpose
(`packages/connector-cmd/src/hookAnswers.ts`):

1. the payload's `questions[]` are normalised
   (`packages/connector-cmd/src/questions.ts`) and emitted as
   `user-input.requested`;
2. the post parks; the timeline shows a question card
   (`apps/web/src/components/approvals/question-card.tsx`) with radio buttons,
   checkboxes for `multiSelect`, and a freeform field where allowed;
3. `thread.userInput.respond` releases it;
4. the tool is **denied**, with the user's answers — in the question's own
   words, not our ids — as `permissionDecisionReason`. The model reads them as
   context instead of waiting for a prompt that will never come.

---

## 7. Stop, and the queue

### Stop

The Stop button and the `thread.interrupt` binding (default `Escape`) both
dispatch `thread.turn.interrupt`. The decider rejects it when no turn is
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

The consequence for the next turn is §12: a SIGINT'd run leaves no transcript,
so its session id is not resumable.

### The queue

Print-mode harnesses cannot take a mid-turn message, so a send while a turn is
running goes on a queue instead of racing the session. `thread.turn.start` with
`queued: true` emits `thread.message.queued`, carrying the whole composer input
— text, attachments and mentions. An interrupt that has not settled yet always
queues, whatever the caller asked for.

The strip (`apps/web/src/components/composer/queue-strip.tsx`) is a projection
of `doc.queue`; nothing is removed locally. `thread.queue.remove` and
`thread.queue.reorder` are commands, and the reorder event carries the whole
new order rather than the move, so a projector never replays arithmetic.

Draining happens on `thread.turn.completed`. The dequeue is chosen **inside**
the append transaction, on the document as it is at append time, so a
`thread.queue.remove` decided in between cannot let a message leave the strip
and be sent anyway. The follow-up turn is dispatched with `queued: true` and
its receipt is read: if anything makes the decider refuse it — a sibling thread
starting a checkpoint restore, the user archiving the thread — the message is
re-queued rather than destroyed.

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
sibling thread of the same project** is — the git work rewrites the project's
whole workspace root, so the exclusion has to be project-wide. For the same
reason a restore in flight bars a new turn.

`ThreadDetailSnapshot.restoring` carries the in-flight checkpoint, so a window
reloaded mid-restore still says "Restoring the worktree…" instead of offering a
button that can only be rejected.

### The Changes pane

`apps/web/src/components/panes/changes/changes-pane.tsx` is the dock's first
tab. A turn selector picks the comparison — working tree, one turn's
checkpoint, or checkpoint to checkpoint — and `git.diff` answers with the file
list, because `GitDiff.files` already carries the path, the `+`/`-` counts and
the per-file patch. `git.status` is read alongside for the branch line and to
tell "not a git repository" (`isRepository: false`) from "nothing changed".

Nothing refetches on a command receipt, because both writes that move the
worktree finish _after_ the command that started them. The pane watches the
thread snapshot instead: a restore records the sequence it was accepted at and
refetches once the snapshot passes it; a turn refetches when `currentTurnId`
falls back to null.

`checkpoints.list` intersects the timeline's own fold of
`thread.checkpoint.created` with the refs that still exist in the repository,
so the pane never offers a restore that can only fail.

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

## 11. Settings

### The document

Settings are server-owned. The renderer reads them with `settings.get`, watches
`settings.subscribe`, and patches with `settings.update`, so a change made in
one window shows up in the other. The schema is
`packages/contracts/src/settings.ts`; the store is `SettingsStore` in
`apps/server/src/rpc/services.ts`, which persists the whole document as one
JSON row in the `settings` table.

```
Settings
  connectors   ConnectorInstanceConfig[]   id, kind, displayName, enabled, config
  defaults     { model, effort, runtimeMode }
  theme        system | light | dark
  keybindings  Keybinding[]
  permissions  PermissionRule[]            a projection of the permission_rules table
```

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

`DEFAULT_KEYBINDINGS` in `packages/contracts/src/settings.ts`:

| command                 | shortcut      |
| ----------------------- | ------------- |
| `thread.new`            | `Cmd+N`       |
| `commandPalette.toggle` | `Cmd+K`       |
| `composer.queue`        | `Cmd+Enter`   |
| `thread.interrupt`      | `Escape`      |
| `browserPane.toggle`    | `Cmd+Shift+B` |
| `sidebar.toggle`        | `Cmd+B`       |
| `skills.open`           | `Cmd+Shift+S` |
| `settings.open`         | `Cmd+,`       |

`Cmd` is the platform modifier — Meta on macOS and iOS, Ctrl elsewhere — so one
stored binding works on every keyboard; `Ctrl` always means the physical Control
key. Matching is exact on modifiers: `Escape` does not fire on `Shift+Escape`,
`Cmd+K` does not fire on `Cmd+Alt+K`. A binding may carry a `when` clause over
context flags (`composerFocus`, `threadRunning`, …) with `!`, `&&`, `||`,
parentheses and `==`/`!=`; an unknown flag is false and an unparseable clause
disables the binding rather than misfiring
(`packages/client-runtime/src/keybindings.ts`).

There is exactly one listener, mounted at the app root
(`apps/web/src/lib/shortcuts.tsx`). It runs in bubble phase so focused controls
get first refusal and it skips `defaultPrevented` events — an interaction card
claims `1`/`2`/`3`/`d`/`Escape` in capture phase, and the composer's trigger
menu eats `Escape` before that, so the global table only ever sees what nothing
closer to the focus wanted. A surface that owns a command registers a handler
while it is mounted, and a surface that is not mounted does not answer its
command: `thread.interrupt` belongs to the composer, so it is inert on the
settings page rather than reaching into a thread nobody is looking at.
Registration is a stack per command id, so two surfaces claiming the same id
hand it back in order instead of blanking it
(`apps/web/src/lib/command-registry.ts`).

An empty table in the settings document falls back to `DEFAULT_KEYBINDINGS`,
because a renderer with no shortcuts at all is indistinguishable from a bug;
once the table holds any row it is authoritative, so a binding the user removed
stays removed. The editor shows that same effective table rather than the raw
one — showing the empty list would let someone add one row, save, and silently
unbind everything else.

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
under a second session in the same project. A file that exists but is not strict
JSON is never rewritten — the session runs without the gate and says so.

**The local MCP scope** gets an `openade` entry. That file lives at
`~/.commandcode/projects/<slug>/mcp.json`, and the slug is a private rule the
CLI owns, so **the CLI writes it**: `cmd mcp add-json --scope local`, and `cmd
mcp remove` to take it back. Writing it ourselves put the entry beside the
directory the harness reads whenever the workspace path has a camel hump or an
underscore in it, which silently offered the model no browser tools at all in
those projects. The entry is removed by name, so a server the user added under
any other name is untouched.

The settings UI edits a different pair of files through
`apps/server/src/settings/CmdConfig.ts`: `~/.commandcode/mcp.json` for user
scope and `<workspaceRoot>/.mcp.json` for project scope. Ownership there is per
entry — every server OpenAde writes carries an `_openade` marker — and
upsert/remove refuse to touch an entry without it. Disabling is a move, not a
flag: Command Code launches everything under `mcpServers` and ignores keys it
does not know, so a disabled server's definition is parked verbatim under
`_openadeDisabled`. A file that cannot be parsed is never rewritten; listing
reports no servers for it and writes fail with a `conflict` naming the file,
because a rewrite would be built from an empty base and would delete every
server the user hand-authored.

**Skills** are discovered, not written: `cmdConfig.skills.list` walks
`~/.commandcode/skills` and `<workspaceRoot>/.commandcode/skills`, reads the
`name` and `description` out of each `SKILL.md` frontmatter, and lets a project
skill win a name collision, matching the harness's own precedence. The composer's
`/` popover reads that list.

---

## 12. Crash and recovery

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

## 13. Shutdown

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

On the server side, closing `boot`'s scope shuts everything down. Two
finalizers matter:

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

---

## Where to look next

| area                                   | start here                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| the pieces, one by one                 | [architecture.md](architecture.md)                                                                                                            |
| the rules and where they are enforced  | [philosophy.md](philosophy.md)                                                                                                                |
| running, testing, packaging            | [development.md](development.md)                                                                                                              |
| the CLI on the far end                 | [command-code-connector.md](command-code-connector.md)                                                                                        |
| commands, events, read models          | `packages/contracts/src/orchestration.ts`                                                                                                     |
| the connector-neutral event vocabulary | `packages/contracts/src/runtime.ts`                                                                                                           |
| the RPC surface                        | `packages/contracts/src/rpc.ts`                                                                                                               |
| the composition root                   | `apps/server/src/boot.ts`                                                                                                                     |
| the decider                            | `apps/server/src/orchestration/decider.ts`                                                                                                    |
| the Command Code session               | `packages/connector-cmd/src/session.ts`                                                                                                       |
| what the real CLI does                 | `packages/testkit/fixtures/cmd/README.md`                                                                                                     |
| the product, end to end                | `apps/server/test/e2e/` — ten scenarios over a real server, a real socket and either the real CLI (`OPENADE_LIVE_CMD=1`) or a recording of it |
