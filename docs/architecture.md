# Architecture

OpenAde is a desktop application that drives an agentic coding CLI and gives it
a real interface: a sidebar of projects and threads, a streaming timeline,
approval cards, a diff pane, a browser pane, a file pane, settings.

Nothing above the connector boundary knows which CLI is running. A _connector_
owns a harness — how to find its binary, how to spawn it, how to translate what
it emits into the `RuntimeEvent` vocabulary — and everything else is written
against that vocabulary. One connector ships today:
`packages/connector-cmd`, for the Command Code CLI (`cmd`).

This document describes the pieces and how they connect, written against the
code as it stands. Its companions:
[how-it-works.md](how-it-works.md) traces what happens at runtime,
[philosophy.md](philosophy.md) says which of these shapes are rules and where
they are enforced, [development.md](development.md) is how to run and check the
thing, and [command-code-connector.md](command-code-connector.md) is what the
`cmd` CLI actually does.

## Processes

Three processes of our own, plus two children the server starts.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron main — apps/desktop/src/main                               │
│   window + openade:// protocol + IPC + will-attach-webview policy   │
│   ServerSupervisor — apps/desktop/src/backend/ServerSupervisor.ts   │
└──────┬────────────────────────────────────────┬─────────────────────┘
       │ spawn, handshake on fd 3               │ preload bridge (IPC)
       ▼                                        ▼
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ server — apps/server         │ ws   │ renderer — apps/web          │
│ Effect · SQLite · HTTP + WS  │◄─────┤ React · TanStack Router      │
│   /ws  /healthz  /mcp        │      │ atoms · timeline · composer  │
│   /hooks/pretooluse          │      │ right dock                   │
└───┬──────────────────┬───────┘      └──────────────────────────────┘
    │ spawn (per turn) │ execFile (per call)
    ▼                  ▼
 cmd child         agent-browser
 one per turn      browser pane / browser_* tools
```

**Electron main → server.** `ServerSupervisor` spawns the server as a child
with `stdio: ["ignore", "inherit", "inherit", "pipe"]` — fd 3 is the handshake
pipe. The server writes one JSON line to fd 3 (`writeHandshake` in
`apps/server/src/rpc/bootstrap.ts`) carrying `{ url, token, serverInstanceId }`,
and falls back to stdout when fd 3 is not a handshake pipe — including when the
process has a node IPC channel, which also lands on fd 3. The supervisor reads
at most 64 KiB waiting for that line, gives up after 15 seconds, restarts on crash
with 500ms→10s backoff, and after five consecutive failures stops and reports
instead of spinning (`onRepeatedFailure`, wired to a dialog in
`apps/desktop/src/backend/serverDeps.ts`).

What is spawned is in `apps/desktop/src/backend/serverArgs.ts`: the packaged
`out/server/main.cjs` under `ELECTRON_RUN_AS_NODE`, or in dev
`node --import <tsx loader> apps/server/src/main.ts`. The `--import` form
matters — the `tsx` CLI re-execs node, and the grandchild does not inherit
fd 3.

**Electron main → renderer.** The renderer is served from the app's own
`openade://app/` scheme with SPA fallback (`apps/desktop/src/main/protocol.ts`,
`rendererRequest.ts`). The preload bridge
(`apps/desktop/src/preload/bridge.ts`) exposes `getConnection`,
`getServerState`, `onServerState` and the browser-pane guest channel; it is
built against a three-member `PreloadIpc` interface so it can be tested without
Electron.

**Renderer → server.** One WebSocket to `ws://127.0.0.1:<port>/ws?token=…`. The
token is the boot token from the handshake, compared in constant time
(`apps/server/src/rpc/server.ts`); anything else gets 401 before the RPC
protocol runs. `packages/client-runtime/src/resolver.ts` finds the credentials:
the preload bridge first, then the dev endpoint `GET /__openade/connection`
served by the Vite plugin in `apps/web/vite.config.ts` out of
`~/.openade/dev/connection.json`, then `?server=&token=` search params.
Credentials are re-read on every connect attempt, because a supervisor restart
means a new port, a new token and a new `serverInstanceId`.

**Server → CLI.** One child process per turn. Command Code's print mode is one
turn per process, so `send` spawns `cmd -p "<prompt>" --session <id> …`,
`detached` so it leads its own process group and interrupt/close can signal the
group.

**Server → agent-browser.** `execFile` in argv form, never a shell, one
invocation per call against a named session
(`apps/server/src/browser/agentBrowser.ts`). The Rust daemon underneath
persists between invocations.

## Workspaces

A pnpm workspace driven by turbo. Packages are scoped `@OpenAde/*` and consumed
through their `exports` map, one entry per module; apps are unscoped.

| Directory                 | Package name              | What it is                                                 |
| ------------------------- | ------------------------- | ---------------------------------------------------------- |
| `apps/desktop`            | `desktop`                 | Electron main, preload, server supervisor, platform glue   |
| `apps/web`                | `web`                     | The renderer: routes, atoms, timeline, composer, panes     |
| `apps/server`             | `server`                  | The Effect server: store, orchestration, RPC, gateways     |
| `packages/contracts`      | `@OpenAde/contracts`      | Schemas: ids, enums, runtime, orchestration, settings, rpc |
| `packages/connector-sdk`  | `@OpenAde/connector-sdk`  | What a connector is, and the suite every one must pass     |
| `packages/connector-cmd`  | `@OpenAde/connector-cmd`  | The Command Code connector                                 |
| `packages/client-runtime` | `@OpenAde/client-runtime` | Connection, folds and atoms shared by any client           |
| `packages/shared`         | `@OpenAde/shared`         | Ids, paths, permission patterns, image sniffing            |
| `packages/ui`             | `@OpenAde/ui`             | The base component set and its styles                      |
| `packages/testkit`        | `@OpenAde/testkit`        | Recordings, the replayer, the fake connector, test helpers |
| `packages/config`         | `@OpenAde/config`         | The shared `tsconfig.base.json`                            |

## Boundaries

`scripts/check-boundaries.mjs` enforces five rules over the tree, and it is part
of `pnpm check`. The rules are pure functions in `scripts/boundary-rules.mjs`,
tested by `scripts/boundary-rules.test.mjs`, which `pnpm check:boundaries` runs
before the walk.

**1. Import allowlist.** A workspace may import itself and whatever the table
says; anything else fails. A workspace with no rule may import no workspace
package at all. The rule applies however the import is spelled — `from`, bare
`import`, dynamic `import()`, `require()`, and template literals with a static
package segment.

| Workspace                 | May import                                    |
| ------------------------- | --------------------------------------------- |
| `apps/web`                | `ui`, `contracts`, `client-runtime`, `shared` |
| `apps/desktop`            | `contracts`, `shared`                         |
| `apps/server`             | `contracts`, `connector-sdk`, `shared`        |
| `packages/connector-sdk`  | `contracts`, `shared`                         |
| `packages/connector-*`    | `connector-sdk`, `contracts`, `shared`        |
| `packages/contracts`      | `shared`                                      |
| `packages/client-runtime` | `contracts`, `shared`                         |
| `packages/testkit`        | `contracts`, `connector-sdk`, `shared`        |
| `packages/shared`         | nothing                                       |
| `packages/ui`             | nothing                                       |
| `packages/config`         | nothing                                       |

Test files under `apps/server` get three extras: `testkit`, `client-runtime`
and `connector-cmd`. A file counts as a test when `.test.`/`.spec.` precedes its
extension, or when any path segment is `test` — which is how the end-to-end
harness under `apps/server/test/e2e/` qualifies. Keeping them out of the
production list is what makes an accidental import in `apps/server/src/main.ts`
fail: `apps/server` is bundled to a single file for packaging, and testkit must
never ship. One production file has an extra of its own:
`apps/server/src/boot.ts`, the composition root, may import `connector-cmd` to
build the registry. Every other server file reaches a connector through the
registry.

A relative specifier that climbs out of its own workspace directory is a
violation whatever it lands on. `../../../packages/testkit/src/receipts` is a
boundary crossing wearing a path.

**2. Connector leaks.** Non-test sources under `apps/web`,
`packages/client-runtime` and `apps/server` — `boot.ts` aside — import no
`@OpenAde/connector-*` package other than `connector-sdk` and contain no quoted
connector kind (`"cmd"`, `"claude"`, `"codex"`, `"opencode"`, any quote style).
A connector kind travels as data, from the registry and `connectors.describe`;
code that compares against one by name is branching on a harness. The one
exemption is by exact path, with its reason beside it:
`packages/client-runtime/src/keybindings.ts`, where `"cmd"` is the Command key.

**3. Renderer connector-neutrality.** The strings `command code` (spaced or
not), the quoted literal `"cmd"`, and `claude`, `codex` and `opencode` as words
must not appear anywhere under `apps/web/src` — in any file, whatever its extension, and in file names as well
as contents. One path is exempt, `apps/web/src/components/ui/icons`, so a
connector's own logo can ship under its own name; nothing lives there today.
The renderer renders whichever connector is configured; a connector's name in a
CSS class, an SVG title or a JSON label breaks that as surely as one in a string
literal. This is why a connector's name, icon key and docs link arrive as
`ConnectorMetadata` over `connectors.describe`, and a failing probe's own help
link as `ConnectorProbe.helpUrl`, rather than being written into a component.
The contracts package names no connector either: there is no kind constant and
no connector config schema in it.

**4. Reference names.** The products OpenAde was compared against while it was
built are not named anywhere in `apps/`, `packages/`, `scripts/` or the
top-level `docs/*.md`, in file names or contents, in any case. Recorded
fixtures, `node_modules`, build output and the local `docs/plans/` are skipped.
The guard keeps the names base64-encoded so that it does not spell them.

**5. No barrels.** An `index` module anywhere under `packages/` is refused —
`.ts`, `.tsx`, `.js`, `.jsx` or `.mjs`: a package exports one entry per module
through its `exports` map. Apps are exempt — the router's
`apps/web/src/routes/settings/index.tsx` is a route, and the Electron entry
points are named by electron-builder.

A second guardrail, `scripts/check-file-sizes.mjs`, caps non-test source files
at 800 lines and renderer components under `apps/web/src/components` at 400.

## The apps and packages, one by one

### apps/desktop

Owns the operating system. Nothing about orchestration lives here.

- `apps/desktop/src/main/index.ts` — single-instance lock, privileged scheme registration,
  supervisor start, window creation, quit handling (`quit.ts`, with a 15s
  deadline for the server child).
- `apps/desktop/src/main/protocol.ts` — the `openade://app/` scheme.
- `apps/desktop/src/main/webview.ts` — the `will-attach-webview` policy for the browser
  pane. Only `persist:thread-*` partitions may attach, and the handler
  overwrites the guest's `webPreferences` rather than only refusing bad ones,
  so a guest that reaches that point still runs sandboxed, context-isolated,
  without Node and without a preload.
- `apps/desktop/src/main/ipc.ts` — the preload bridge's handlers, including the guest input
  relay: `before-input-event` and `before-mouse-event` on the guest webContents
  are the only place a pane gesture is observable, and they are relayed to the
  host, which forwards them as `browser.humanInput`.
- `apps/desktop/src/backend/` — `ServerSupervisor`, the spawn spec, the public server state
  the renderer sees.
- `apps/desktop/src/platform/` — per-platform window defaults, lifecycle, the CDP port.

Public seam: the preload bridge object, whose shape the renderer declares in
`packages/client-runtime/src/resolver.ts`. May import `contracts` and `shared`
only; must never import the server, the connector packages or the renderer.

### apps/web

The renderer. TanStack Router routes under `apps/web/src/routes`, state through
`@effect/atom-react`, components under `apps/web/src/components`.

| Route                             | What it is                                                         |
| --------------------------------- | ------------------------------------------------------------------ |
| `_home/index`                     | start a thread, pick a project                                     |
| `_home/t/$threadId`               | the thread view; `?pane=` carries the dock tab                     |
| `_home/customize/{skills,mcp}`    | what extends the agent, one tab per kind, one section per instance |
| `settings`, four pages            | general, models, connectors, keybindings                           |
| `browser.$threadId`               | the marker page the browser pane's `<webview>` guest loads         |
| `dev/{timeline,composer,changes}` | fixture pages, DEV only                                            |

The shell is a left sidebar (projects → threads, with a status icon and an
unread dot), the thread column (timeline, composer, interaction cards) and a
right dock with three tabs: **changes** (a turn selector over `git.diff`),
**browser** (the pane) and **files** (a search over `files.search` that drills
into directories and previews a file through `files.read`, paged by line offset
because a window is capped by characters, not lines). When less than 640px
remains beside the sidebar, the dock overlays the thread so its tabs stay
reachable. Wider rows fit a thread column of at least 360px beside the dock.

The atom runtime is built once. `apps/web/src/state/app-runtime.tsx` owns the
single `makeRuntime` instance, the shared registry and the offline layer that
keeps every atom mountable when there is no server;
`apps/web/src/lib/app-runtime.ts` adds the settings atoms on top of that
instance; `apps/web/src/lib/client-runtime.tsx` publishes it to React
(and lets a fixture page substitute a scripted client). Components read through
`apps/web/src/state/hooks.ts` and hold no RPC client of their own.

Presentation state that never reaches the server lives in
`apps/web/src/state/ui.ts` and the browser's own storage — row disclosure, dock
width, the per-thread dock tab, and the "last seen" stamp behind the unread dot.
There is no `unread` flag on the wire: whether this window has looked at a
thread is not the server's business, and a thread with no stamp is deliberately
not unread.

The three `dev/*` pages load their bodies through a dynamic import inside
`if (import.meta.env.DEV)`, so no fixture data reaches a production bundle.

Public seam: none; it is a leaf. May import `ui`, `contracts`,
`client-runtime`, `shared`. Must never name a connector.

### apps/server

The whole backend, assembled in one composition root.

`apps/server/src/boot.ts` builds the layer graph and starts it in the calling scope:
closing that scope shuts down the server, the database and every open connector
instance. It returns once the handshake is written, which is the moment the
first client may connect. Two things about it are load-bearing:

- **One `Layer.build` for the whole graph.** `Layer.build` memoizes per call, so
  a layer handed to two builds is constructed twice. `OrchestrationEngine` and
  `SessionManager` are reachable both from the services (through the browser
  service and the MCP gateway) and from the server (through the RPC handlers and
  the reactors); two builds gave the process two of each, sharing a database but
  not their PubSubs.
- **`ConnectorHost.install` runs before the handshake.** The connector manager
  opens instances while the graph is still building, before the HTTP server
  listens or the hook bridge exists, so the `ConnectorServices` it hands them is
  a façade that `install` fills in with the real MCP endpoint, hook endpoint,
  hook handler registry and permission ladder. `boot` then waits on
  `ConnectorManager.ready` so no client is admitted while `ConnectorSelection`
  would still answer `NoConnector`.

Directories, relative to `apps/server/`:

| Path                 | What lives there                                                                   |
| -------------------- | ---------------------------------------------------------------------------------- |
| `src/persistence/`   | `Sqlite`, `EventStore`, `ReadModels`, `Migrations`, `migrations/*`                 |
| `src/orchestration/` | decider, engine, state fold, reactors, session manager and supervisor, live buffer |
| `src/rpc/`           | WebSocket transport, handlers, service tags, handshake, origin check               |
| `src/permissions/`   | the ladder, the pattern re-export, the sensitive-path list                         |
| `src/hooks/`         | the PreToolUse bridge                                                              |
| `src/mcp/`           | the MCP gateway and its HTTP routes                                                |
| `src/browser/`       | browser service, agent-browser CLI, driver, tool catalogue                         |
| `src/git/`           | status/diff, file search and read, checkpoint store and hook                       |
| `src/fs/`            | `fs.browse`                                                                        |
| `src/settings/`      | settings store users, connector manager and host, connector extension routing      |
| `src/attachments/`   | the staging store and its reactor                                                  |

Public seam: the RPC group in `packages/contracts/src/rpc.ts` and the three
loopback HTTP routes. May import `contracts`, `connector-sdk`, `connector-cmd`,
`shared`; `testkit` and `client-runtime` in tests only. Must never import
`apps/web` or `apps/desktop`.

### packages/contracts

Every wire shape, as `effect/Schema` codecs. Modules: `base`, `ids`, `enums`,
`runtime`, `orchestration`, `settings`, `connectors`, `rpc`. `connectors` holds
what the renderer learns about a connector — models, probe, configured
instances, metadata and config form, and the skills and MCP servers its
extensions list — and `rpc` holds the methods that carry them.

Ids are branded UUIDv7 strings, so a `ThreadId` cannot be passed where a
`TurnId` is expected, and they are validated on decode — a malformed id fails at
the transport boundary rather than deep inside a projection. `ConnectorKind` is
deliberately an unconstrained string: adding a connector must not touch this
package.

`Effort` is the canonical reasoning ladder, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, exported in that order as `EFFORT_ORDER`. It is a superset: which
rungs a model accepts is `ModelOption.efforts`, and a harness maps its own names
onto these. The union only grows, so a stored thread's effort always decodes.

Public seam: its `exports` map. May import `shared` only.

### packages/connector-sdk

What a connector is, and the promises it must keep.

- `definition.ts` — `ConnectorDefinition<Config>`, `ConnectorInstance`,
  `ConnectorServices`, the error union, `eraseConnectorDefinition`.
- `sessionHandle.ts` — `SessionHandle` and the bounded event queue.
- `turnScopedHandle.ts` — the turn correlation wrapper.
- `extensions.ts` — the optional per-instance extensions (skills, MCP servers).
- `approvalGate.ts` — the shared approval flow: ask the permission ladder, and
  on prompt open a request and park until the user answers.
- `registry.ts` — definitions by kind, live instances by id.
- `conformance.ts` — the executable suite.
- `streamCollector.ts` — the collector the suite and testkit share.

May import `contracts` and `shared`. Must never import the server or any
connector.

### packages/connector-cmd

The Command Code connector. `definition.ts` wires the pieces: `probe.ts` and
`binary.ts` (find and interrogate the CLI), `spawn.ts` (argv and the environment
allowlist), `turnArgs.ts` (what one turn's argv is), `session.ts` (one session
per thread), `ndjson.ts` (frame parsing), `translate.ts` (frames →
`RuntimeEvent`), `transcript.ts`, `plans.ts`, `subagents.ts`, `questions.ts`,
`approvals.ts`, `hookAnswers.ts`, `hookScript.ts`, `config.ts`, `exitCodes.ts`,
`sessionRef.ts`, `attachments.ts`, and the two extensions the Customize page
edits through, `mcpServers.ts` and `skills.ts`. `makeCmdConnectorDefinition`
takes the harness's config home, so a test can move it.

May import `connector-sdk`, `contracts`, `shared`. It is the only place in the
tree that knows `cmd` exists, apart from the one line in `boot.ts` that
registers it.

### packages/client-runtime

Everything a client needs that is not React.

- `connection.ts` — the reconnecting supervisor. Effect's socket protocol is
  single-use, so reconnecting rebuilds socket, protocol and `RpcClient`
  underneath callers; `Connection.client` is a per-call accessor that waits for
  whichever client is live. `ConnectionStatus` includes a terminal
  `incompatible` for a protocol-version mismatch.
- `clientState.ts` — the client-side fold: `ThreadStreamItem`s onto a
  `ThreadDetailSnapshot`, `ThreadListStreamItem`s onto a summary array. A
  projection of the server's projection; it decides nothing.
- `atoms.ts`, `gitAtoms.ts`, `fileAtoms.ts`, `fsAtoms.ts` — the atom factories.
- `connectorAtoms.ts` — `modelCatalogAtom`, every enabled connector instance
  with its models in `connectors.list` order, which the model pickers and the
  Models settings page read. It follows `connectorsAtom`, and an instance whose
  `connectors.models` fails lists no models without emptying the others.
- `resolver.ts`, `desktop.ts` — how a client finds its server and its shell.
- `composerTrigger.ts`, `keybindings.ts` — shared input logic.

May import `contracts` and `shared`.

### packages/shared

Dependency-light helpers both sides need: `ids.ts` (UUIDv7), `paths.ts`
(`~/.openade` and everything under it), `permissionPattern.ts` (the pattern
parser and matcher, shared so the renderer previews an "allow always" rule with
the exact semantics the server enforces), `imageBytes.ts` (magic-byte sniffing
and the attachment size cap). Imports no workspace package at all.

### packages/ui

The base component set (`src/components`), hooks, `lib`, and `globals.css`.
Imports no workspace package.

### packages/testkit

Test infrastructure, never shipped.

- `packages/testkit/fixtures/<kind>/` — real recordings of each harness, one directory per
  scenario, keyed by the connector kind. `fixtures/cmd/` holds Command Code's, indexed by its
  `README.md`. Nothing in them is hand-written; when the CLI changes they are re-recorded.
- `packages/testkit/src/recording.ts` — the transport-neutral recording format: the versioned
  manifest (`formatVersion`, `kind`, `transport`, `real: true`, with defaults for manifests that
  predate those fields), `RecordedFrame` (direction, channel, optional timestamp, data), the
  `fixtures/<kind>/` lookup, and the `Replayer` shape each transport implements.
- `packages/testkit/bin/replay-cmd.mjs` — puts a recording back on the wire with no behaviour of
  its own; `packages/testkit/src/replayCmdProcess.ts` loads a recording through `recording.ts`,
  flattens a turn into `RecordedFrame`s, and produces the spawn configuration that makes the
  replayer stand in for `cmd` (`cmdReplayer`, transport `stdio-ndjson`).
- `packages/testkit/src/fakeConnector.ts` — a real `ConnectorDefinition` whose sessions replay a
  scripted event list, for everything above the connector layer.
- `packages/testkit/src/receipts.ts` — await a command by its receipt instead of sleeping.
- `packages/testkit/src/sqlite.ts` — a throwaway database on the same engine the server uses.
- `packages/testkit/scripts/record-cmd.mjs` and `record-probe.mjs` — the
  recorders. They spend a
  real account's plan, so they are never run from CI.

May import `contracts`, `connector-sdk`, `shared`.

## The data model

SQLite through `node:sqlite`'s `DatabaseSync`, one connection for the process,
serialised by a semaphore (`apps/server/src/persistence/Sqlite.ts`). SQLite is a
single-writer engine and keeping every statement on one connection is what makes
`withTransaction` mean what it says. WAL on, `busy_timeout` 5000ms. The database
holds every prompt, answer, tool input and diff, so the directory is created
0700 and the database and its `-wal`/`-shm` siblings are chmodded 0600 — on
every open, because neither `mkdir` nor `open` lowers the mode of something that
already exists.

### Events

`events` is append-only and is the source of truth. Everything else is a
projection of it.

| Column                                               | Meaning                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `sequence` (INTEGER PK AUTOINCREMENT)                | the global cursor: client resume and projector watermark |
| `event_id`                                           | unique event id                                          |
| `stream_kind`, `stream_id`                           | the aggregate: `project` or `thread`, and its id         |
| `stream_version`                                     | per-stream 1..N, unique with the two above               |
| `type`, `payload_json`, `occurred_at`                | the event itself                                         |
| `command_id`, `causation_event_id`, `correlation_id` | provenance                                               |
| `actor`                                              | `user`, `system` or `connector`                          |

Indexes: `(stream_kind, stream_id, sequence)`, `(command_id)`,
`(correlation_id)` and `(type, sequence)`.

`EventStore.append` reads the stream's current maximum version, assigns
`base + n`, and relies on `UNIQUE (stream_kind, stream_id, stream_version)` as
the optimistic-concurrency backstop. The engine serialises writers, so a
violation means a bug rather than contention, and it surfaces as
`ConcurrencyConflict`.

Every planned event is decoded against the `OrchestrationEvent` union _before_
it is written. The refined schema types are not branded — `NonEmptyString`'s
`.Type` is plain `string` — so TypeScript accepts values the schema rejects, and
a row like that is a poison pill: every read path decodes, so one bad payload
stopped the thread opening and took the server's boot replay with it. A rejected
payload now fails the command that produced it (`InvalidEvent`). On the read
side, a row that still cannot be decoded is logged and skipped rather than
thrown, because throwing escaped as a defect past `Effect.catch`.

`command_receipts` (`command_id` primary key, status, reason, `last_sequence`)
is what makes dispatch idempotent: a retried `commandId` returns its stored
receipt instead of deciding again. That is what makes reconnects and client
retries safe, and it is why every id a command needs is minted by the caller.

### Projections

`projects` is the sidebar's project row. `threads` stores `thread_id`,
`project_id`, `title`, `status` and `doc_json` — the whole thread document as
JSON. The snapshot _is_ the projection, so a snapshot read is a single-row fetch
and a rebuild is a pure fold. `ThreadDoc`
(`apps/server/src/orchestration/state.ts`) is the wire `ThreadDetailSnapshot`
plus the bookkeeping the decider needs and the wire never sees: the full open
approval set, pending user inputs, the list preview, the `deleted` flag.

`projection_state` holds one row per projector: `last_applied_sequence`,
`updated_at` and `projector_version`. Projections are written inside the
command's transaction, so a projection can never get ahead of its events.

### Migrations

Numbered files under `apps/server/src/persistence/migrations/`, listed in a
static record in `Migrations.ts`, applied in id order, each in its own
transaction. Ids must be contiguous from 1 and existing files are never edited
once merged; a lineage test enforces both. Every layer that reads a table
provides the migrations layer, so the graph itself says the schema exists first.

| Migration                | What it adds                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `0001_events`            | `events`, its indexes, `command_receipts`, `projection_state` |
| `0002_projections`       | `projects`, `threads` and their indexes                       |
| `0003_settings`          | `settings`, `permission_rules`                                |
| `0004_projector_version` | `projection_state.projector_version`                          |
| `0005_events_type_index` | `events(type, sequence)`                                      |

### Rebuilding projections

`threads.doc_json` is parsed straight back into a `ThreadDoc` with no schema and
no version, so the first release that adds a field would serve stale rows
missing it. The engine stamps `PROJECTOR_VERSION` (currently `1`) on every
watermark write and compares it at boot: on a mismatch it clears the projection
tables inside one transaction, re-folds every stream from `allEvents`, writes
the documents back and stamps the new version. Rows written before the column
existed read back as `0`, which is exactly right — they are stale by definition.

The 0005 index exists for the same class of problem from the other side: the
checkpoint reactor's boot replay used to scan and decode every thread event ever
written, inside the layer build, under the desktop supervisor's fixed 15-second
handshake timeout. With the index it asks for four event types and reads a
handful of rows.

## The orchestration loop

`OrchestrationEngine` (`apps/server/src/orchestration/Engine.ts`) is the single
writer of durable state. Two entry points: `dispatch(command)`, which runs the
decider, and `appendThreadEvents(threadId, planned)`, which is the same append
path without it, for connector- and system-originated events. Both take the
one write mutex.

```
dispatch(command)
  │
  ├─ store.receipt(commandId) ─── already recorded? ──► return that receipt
  │
  └─ BEGIN (one SQLite transaction)
       loadStream(kind, id) ──► foldThread / foldProject ──► state
       buildContext(command) ───────────────────────────────► ctx
       decide(command, state, ctx, env)
          │
          ├─ rejected ─► recordReceipt(rejected, lastSequence)
          │
          └─ accepted
               store.append(events)   → sequence + streamVersion assigned
               applyProjection()      → threads.doc_json / projects
               setWatermark(PROJECTOR, last, now, PROJECTOR_VERSION)
               insertPermissionRule()  (only for "allow always")
               recordReceipt(accepted, last)
     COMMIT
       │
       ├─ publishAll(events)      → subscriptions, reactors
       ├─ invalidate(rules)       → only when a rule was written
       └─ publish(acceptedCommand) → ProviderCommandReactor
```

`decide` (`decider.ts`) is pure: command plus folded stream state plus
cross-aggregate facts plus an id/clock environment, in; events out. No clock, no
I/O, no id minting of its own, which is why a scripted conversation replays
byte-identically in tests. A rejection is a result, not an exception — the
command receipts as `rejected` and nothing is appended.

`DeciderContext` carries the facts the decider may check that are not in its own
stream, gathered inside the transaction: whether the project exists, whether a
workspace root is taken, whether a sibling thread of the same project has a
checkpoint restore in flight (the git work covers the whole worktree, so that
exclusion has to be project-wide), and the settings defaults a `thread.create`
without them inherits.

`appendThreadEvents` accepts a function of the thread document instead of a
fixed list. The function runs inside the write transaction on the document as it
is at append time, so a caller whose events depend on current state — "send the
head of the queue" — cannot be overtaken by a command decided between its read
and its append.

### Commands and events

Fifteen commands (`packages/contracts/src/orchestration.ts`):
`project.create`, `project.remove`, `thread.create`, `thread.rename`,
`thread.archive`, `thread.delete`, `thread.turn.start`, `thread.turn.interrupt`,
`thread.settings.update`, `thread.approval.respond`,
`thread.userInput.respond`, `thread.plan.respond`, `thread.queue.remove`,
`thread.queue.reorder`, `thread.checkpoint.restore`.

Thirty events, from `project.created` through `thread.error`. The catalogue is
kept as data (`commandTypes`, `orchestrationEventTypes`) and a test holds each
list and its union in lockstep.

Commands do not appear as individual RPCs: `orchestration.dispatch` takes the
whole union, which is what keeps the decider the single place a state change is
decided.

A thread chooses its harness through `ThreadSettings.connectorInstanceId`, set
on `thread.create` or by `thread.settings.update`. The field is optional: events
written before it existed decode unchanged, and absent means the default routing
rule. The choice can change only until the thread has a bound session, a
running turn or a user message — `threadLocksConnector` in the contracts is that
rule, read by the decider (which rejects a change after it, suggesting a new
thread) and by the renderer's picker alike. The field is routing, not a session
setting: the reactor strips it before `handle.updateSettings`. The renderer's
model picker is where the choice is made: one section per enabled instance, and
a pick sends the instance with the model.

### Reactors

A reactor consumes the engine's published streams and performs the side effect
an event calls for. Reactors never dispatch as an input to a decision that has
already been made; they act on what was decided. Four of them are merged in
`boot.ts` — `ProviderCommandReactor`, `CheckpointReactor`, `AttachmentReactor`
and the session supervisor — and they subscribe eagerly at layer build, because
a forked fiber does not start until the builder yields and the engine's PubSub
drops what it publishes while nobody is listening. `RuntimeIngestion` is the
exception: one fiber per session, forked by the session manager.

| Reactor                              | Watches                    | Does                                                                                                                                                 |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderCommandReactor`             | the event stream           | turn send, interrupt, approval/question/plan responses, settings push, queue drain, session close, cascade of `project.removed` into `thread.delete` |
| `RuntimeIngestion` (`ingestSession`) | one session's event stream | `RuntimeEvent` → `PlannedEvent`, appended and tagged with the runtime event that caused it; reports session end on the lifecycle channel             |
| `SessionSupervisor`                  | boot scan + lifecycle      | resumes or marks lost                                                                                                                                |
| `CheckpointReactor`                  | the event stream           | capture on turn completion, restore on a work order, prune on deletion                                                                               |
| `AttachmentReactor`                  | the event stream + boot    | purges a deleted thread's attachments and sweeps unreferenced staged files                                                                           |

**`ProviderCommandReactor`.** `turn.requested` → ensure the session and
`handle.send(turnId, turn)`. `turn.interrupted` → `handle.interrupt(turnId)`,
and the turn stays in flight until the connector settles it — this fiber settles
it itself only when there is no live session left to do so.
`approval.resolved` / `userInput.resolved` / `plan.responded` → the matching
`respond*` on the live handle, plus the plan follow-up. `settings.updated` →
`handle.updateSettings`. `turn.completed` → dequeue the head of the queue and
dispatch it as a new turn. A failing side effect records `thread.error` — and a
synthetic `turn.completed` when a turn was mid-flight — rather than leaving a
thread wedged in `running`. Four of the five errors it can see are tagged errors
with no message, so it falls back to the tag: "removed connector" reads very
differently from "session closed", and writing `""` onto `thread.error` produced
a row the union could not decode.

**`RuntimeIngestion`.** `translateRuntimeEvent` is pure except for a
per-session map of item snapshots: `content.delta` frames fold into the item
they belong to, so the log gets whole `thread.item.upserted` snapshots instead
of a delta stream. Streamed text is coalesced on the way in on a 50ms window —
every delta used to become its own upsert carrying the whole accumulated
snapshot, and every append rewrote the thread's whole `doc_json`, which is
O(N²). A held delta is flushed before any other event of the session, so the
log's order is still the connector's order.

**`SessionSupervisor`.** On boot it scans the thread read model inline during
layer build (at real boot the database is the only state that exists, so
"running with no session" genuinely means lost; forking would let live
dispatches interleave). A thread mid-turn or waiting whose session vanished gets
`thread.session.lost`; one still bound to a `sessionRef` gets a `resumeSession`
attempt, up to four attempts with 250ms doubling backoff, then `session.lost`.
While running it watches the lifecycle channel: a `crashed` end writes a visible
`thread.error` notice and starts the same resume loop; a `stopped` end is
deliberate and restarts nothing.

**`CheckpointReactor`.** `CheckpointHook` is the seam the git implementation
fills (`apps/server/src/git/CheckpointHook.ts` over
`apps/server/src/git/CheckpointStore.ts`); the default is an explicit no-op so
the stack runs without git. `turn.completed` → capture → `checkpoint.created`.
A restore is a durable work order: the accepted command writes
`thread.checkpoint.restore.requested` before any git runs, and only after the
git work does `thread.checkpoint.restored` or `restore.failed` follow. Orders
with no recorded outcome are replayed at layer build, so a crash between receipt
and git cannot drop the request. Thread deletion and project removal each prune
the hidden refs under the thread's prefix.

**`SessionManager`.** Not a reactor but the thing reactors act through: one
driver per thread, being the turn-scoped handle plus the ingestion fiber
draining its events into the log. A driver is removed when its event stream ends
or when the thread is deleted. `ConnectorSelection` decides which instance a
thread runs on: by the bound session's persisted `connectorInstanceId` when it
has one; otherwise by the instance the thread chose
(`ThreadSettings.connectorInstanceId`) while that instance is open; otherwise
the default rule, the first instance in the settings document's order that is
actually open. `connectorRouting.ts` is the single reading of that order, shared
with the engine's model seeding so the two can never name different instances.
A `thread.create` that chose an instance and named no model is seeded from that
instance: its `defaultModel`, then its first model, ahead of the app-wide
default, which may belong to another harness.

### Subscriptions

`subscribeThread` and `subscribeThreadList` deliver `snapshot | replay →
synchronized → live`.

```
                     events PubSub
                          │
   subscribe first, then read the baseline (nothing commits in the gap)
                          │
  ┌───────────────────────┴────────────────────────┐
  │ afterSequence absent → snapshot from doc        │
  │ afterSequence present → replay streamAfter      │
  └───────────────────────┬────────────────────────┘
                          │ then { kind: "synchronized" }
                          ▼
   filter: this stream, sequence > cutoff
                          │
                          ▼
   ┌──────────────── LiveBuffer ─────────────────┐
   │ 50ms window, merge by key, arrival order     │
   │ boundary item (mergeKey null) flushes first  │
   │ retained items/bytes charged until pulled    │
   └───────────────────────┬─────────────────────┘
       over 1000 items or 8 MiB │
                               ▼
                 { kind: "resnapshot-required" }, then end
```

The budget is per subscription, and both ends agree on the numbers because they
live in `packages/contracts/src/rpc.ts`: `STREAM_BUDGET_ITEMS` 1000,
`STREAM_BUDGET_BYTES` 8 MiB, `STREAM_COALESCE_MS` 50. Every item delivered but not
yet pulled counts; pulling one releases its charge. A subscriber that falls too
far behind gets a terminal `resnapshot-required` and re-subscribes for a fresh
snapshot, rather than being fed a backlog it will never catch up with.

Coalescing merges replaceable items — the latest `thread.item.upserted` per
`itemId`, the latest usage frame per turn, the latest context frame — and leaves
everything else alone. An item with no merge key is a boundary: it flushes the
pending window first so ordering markers (`synchronized`, turn boundaries) are
never merged away. A merged item moves to the _end_ of the window, because it
carries the newest version of its key and belongs where that version arrived;
replacing in place made a window of two keys flush in first-seen order, and the
client drops an event whose sequence is not greater than the one it holds.

Two ordering details are deliberate. A thread subscription reads its snapshot
and takes the document's `snapshotSequence` as the cutoff. A list subscription
reads `lastSequence` _first_ and the documents second: with the documents read
first, a commit landing in the gap is both missing from the snapshot and
filtered out of the live pump, whereas the other way round a re-delivered event
is an idempotent `upserted`.

## The connector contract

### The definition

```ts
interface ConnectorDefinition<Config> {
  kind: ConnectorKind;
  metadata: ConnectorMetadata; // displayName, iconKey, accent, docsUrl?
  configSchema: Schema.Codec<Config, unknown> & { fields: Schema.Struct.Fields };
  defaultConfig: () => Config;
  probe: (config: Config) => Effect<ConnectorProbe, ProbeFailed>;
  createInstance: (input) => Effect<ConnectorInstance, ConnectorError, Scope>;
}
```

`Config` is invariant, so a heterogeneous list of connectors cannot be typed
directly. `eraseConnectorDefinition` is the answer: it decodes the incoming
`unknown` configuration through the connector's own schema at the boundary where
the untyped value actually enters, and a configuration that does not fit fails
as `ProbeFailed` or `SpawnFailed` for whichever operation needed it.

A definition describes itself, so no layer above it has to. `metadata` is how
it presents itself: `displayName` (what a new instance is named and the
connectors page offers to add), `iconKey` (a generic glyph such as `terminal`,
never a product's logo — the renderer maps it to an icon it ships and falls
back to a generic one), `accent` (a colour, carried as data; the renderer keeps
to the theme's tokens and does not paint it) and an optional `docsUrl`, which
is also the renderer's fallback help link for a probe that failed on the
account. `configSchema` must be a struct whose fields carry `settingsForm`
annotations: erasure reads them once, with `settingsFormFields`, into
`configFields`, the form the connectors page renders for an instance of that
kind. The schema itself never leaves the server. `registry.describe` lists one
`ConnectorDescriptor` (`kind`, `metadata`, `configFields`) per kind the build
ships, in declaration order, and `connectors.describe` answers it.

`probe` answers whether the harness can run a turn on this machine, in
harness-neutral terms. The connector's `ConnectorProbe` carries a `status`
(`ready`, `not-installed`, `not-authenticated`, `error`), `installed` (true
once the harness resolved, even if it then refused), `auth` (`present`,
`absent`, `unknown`), and optionally `version`, `account`, `loginCommand` and
`installCommand` — the commands the harness's own output or docs name for
signing in and installing, left out rather than guessed. It also keeps
`models` and `warnings`, which stay on the server. `toWireProbe` narrows it to
the wire `ConnectorProbe` that `ConnectorSummary.probe` carries, adding
`authenticated` (`auth` as a boolean, absent when unknown) and `modelCount`.
Only the `probing` stand-in an entry reports before its first probe lands has
no `installed`; a probe that never ran (no definition for the kind, a
`ProbeFailed`, the timeout) reports `installed: false`. The
renderer builds every health message from these fields, so it never names a
harness's commands itself.

A `ConnectorInstance` is one _configured_ connector, live —
`startSession`, `resumeSession`, `listModels`, plus its capabilities.
`ConnectorCapabilities` is what the harness can do, and the renderer reads it
instead of the kind:

| Capability                   | Values                               | Read by                                              |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `modelSwitch`/`effortSwitch` | `per-turn`, `in-session`, `restart`  | the header pickers: applies now, next turn, or never |
| `planMode`                   | boolean                              | the plan toggle                                      |
| `runtimeModes`               | the `RuntimeMode`s a session honours | the mode picker, which offers only these             |
| `images`                     | boolean                              | the composer, which refuses attachments when false   |
| `attachments`                | `images` or `files`                  | not yet: `attachments.stage` stages images only      |
| `interrupt`                  | `turn` or `session`                  | what stopping cancels                                |
| `rollback`                   | boolean                              | whether the harness can rewind its own conversation  |
| `compaction`                 | boolean                              | whether compaction can be asked for on demand        |
| `questions`                  | boolean                              | whether a turn can put a question to the user        |
| `subagents`, `resume`        | boolean                              | declared                                             |
| `steering`, `fork`           | boolean                              | declared; read once a harness supports them          |

`steering` also decides `TurnInProgress`, below.

An instance may also carry `extensions` (`extensions.ts`): harness
configuration it manages for the Customize page. `skills` lists what the
harness loads (`list`), and optionally what a shared folder offers
(`available`) and a way to link one in (`link`); `mcpServers` lists, adds
(an upsert) and removes servers in the harness's own config. Both take an
`ExtensionScope` — `{ workspaceRoot: string | null }`, the user scope plus one
project — and fail with `ConnectorExtensionFailed { code, message }`, never an
RPC error: the server (`settings/ConnectorExtensions.ts`) resolves the
`projectId` to a workspace root, calls the open instance's extension, maps the
failure's code across, and answers `unavailable` for an instance that is not
open or has no such extension. `ConnectorSummary.extensions` tells the renderer
which instances have which, so it shows a Customize section only for those, and
the composer's `/` menu asks the thread's own instance for its skills.

Instances
are per configuration, not per thread. The registry (`registry.ts`) routes by
**instance id, never by kind**: two instances of the same harness with different
binaries, credentials or default models are a normal configuration, and a thread
bound to one must never be handed the other. A thread names the instance it
runs on with `ThreadSettings.connectorInstanceId`, fixed once it has run
anything; without one, the default routing rule picks
([Commands and events](#commands-and-events)). A definition is looked up by kind
exactly once, when an instance is opened from the settings document.

`ConnectorServices` is everything the server lends a connector: `mcpEndpoint`
and `hookEndpoint` per thread (each a URL plus a per-session bearer), the hook
handler registration pair, the permission ladder, the attachments directory, a
logger that annotates lines with the thread they came from, and a clock.

### The session handle

`SessionHandle` is the live surface of one session: `events`, `send`,
`interrupt`, `respondToRequest`, `respondToUserInput`, `respondToPlan`,
`updateSettings`, `sessionRef`, `close`. `send` fails with `TurnInProgress` when
a turn is running and `capabilities.steering` is false; the caller's recourse is
to queue, which is what `thread.turn.start { queued: true }` is for. `close` is
not best-effort: it resolves only once the connector has proved the process tree
it started is gone.

**The bounded queue.** `makeBoundedEventQueue` is a dropping queue of 2048
slots, of which the last 64 are reserved for terminal events —
`turn.completed`, `session.ended`, `runtime.error`. An ordinary event offered
when the buffer is within the reserve is dropped and counted; a terminal event
may use those slots. Offering never suspends, so a connector's parser fiber can
never be blocked by a slow consumer. A harness that floods loses chatter, which
costs a redraw; losing a `turn.completed` would strand a turn in `running`
forever.

### The turn-scoped handle

`makeTurnScopedHandle` is the single place allowed to join a harness's own
notion of a turn to ours. The server mints a `TurnId` before the process is
spawned; the harness numbers its turns differently or not at all. Three rules:

1. **While a turn is active, every event belongs to it.** Envelopes are stamped
   with our `turnId`, and so is the `turnId` inside the payloads that carry one,
   so a projection never has to guess and never sees the two disagree.
2. **A turn always ends.** If the event stream ends or fails while a turn is
   unsettled, a `turn.completed` with `stopReason: "error"` is synthesized. A
   `runtime.error` with `fatal: true` settles the turn the same way without
   waiting for the stream to end; a non-fatal one is just news.
3. **Turns do not overlap.** A second `send` for a different turn is refused
   with `TurnInProgress`; sending the same turn twice is a no-op, so a retry
   after a lost receipt does not send the prompt twice. Once the stream is over,
   `send` refuses with `SessionClosed`.

`interrupt(turnId)` and `awaitTurn(turnId)` return only once the turn has
actually settled, so the caller that interrupted can act on a thread that is
genuinely idle. Settling is observed on `events`, so a caller that interrupts
must have that stream running.

### The conformance suite

`runConnectorConformance` (`packages/connector-sdk/src/conformance.ts`) drives
the real definition — `createInstance`, `startSession`, `send`, `close` — and
asserts five promises the engine is written against, for every connector at
once:

1. A session announces itself before it reports any work.
2. Every turn completes exactly once.
3. Every approval request it opens is eventually resolved.
4. Nothing about the work is emitted after `close`.
5. `close` proves the process tree is gone.

A sixth case rides along: every event the connector emitted is encoded back
through the `RuntimeEvent` schema, so a payload that only looks right fails here
rather than at the transport. It proves nothing about vocabulary coverage, and
its name says so. `isProcessGone` is the one hook the suite needs from outside,
because proof that a process tree is gone cannot come from the event stream by
definition.

### The runtime vocabulary

Twenty-three `RuntimeEvent` variants (`packages/contracts/src/runtime.ts`), all
sharing one envelope (`eventId`, `connectorInstanceId`, `threadId`, `createdAt`,
optional `turnId`/`itemId`/`requestId`, optional `raw`): session lifecycle,
turn lifecycle and plan proposal, item started/updated/completed, content
deltas, approval requests and resolutions, user-input requests and resolutions,
subagent task lifecycle, usage, context, model change, MCP status, runtime
errors, and `event.unmapped`.

`event.unmapped` is the escape hatch, and `raw` is mandatory on it: a frame the
connector recognises as belonging to the session but cannot translate is kept,
so a harness change shows up rather than vanishing.

Items are sent whole rather than as patches, so a late subscriber, a resnapshot
and a replay all converge on the same row.

## The Command Code connector

The seam described above, filled in for one CLI. What follows is the shape of
the connector inside this architecture; every fact about the harness itself —
the argv, the frame catalogue, the hook payload, the version policy, plan mode,
subagents, exit codes, resume — is in
[command-code-connector.md](command-code-connector.md), read off the code and
the recordings under `packages/testkit/fixtures/cmd/`.

**One process per turn.** Print mode takes one turn per process, so `send`
spawns a child, waits for it to exit, and settles the turn. The child is
`detached` so interrupt and close can signal its whole process group. Of the
inherited environment it sees only an allowlist; the operator's `extraEnv`
passes by name; the session's own `OPENADE_*` control plane is applied last so
nothing can override it.

**Three sources feed one event stream.** NDJSON frames on stdout are the live
source. The transcript on disk is history — it is appended once per completed
message, one model round trip behind, so it cannot drive a live UI, but it is
what survives a restart, what carries per-message cost, and what a resumed
session reads. Hook posts are the third. One translator per session, not per
process, dedupes the overlap across turns.

**Turn boundaries.** A turn is a process, from `run_start` to `run_end`. The
harness's own `turn_start`/`turn_end` frames count model round trips inside it,
of which one user turn can contain several.

**Approvals** ride the PreToolUse hook (below), which is the only approval
channel print mode has.

**Files we write into the user's world**, both reverted when the session closes
(`config.ts`): the PreToolUse hook block in
`<workspaceRoot>/.commandcode/settings.local.json`, reverted only while the file
still hashes to the bytes we wrote and only once the last session in that
project has closed; and the `openade` MCP entry in the CLI's local scope,
written and removed _through the CLI_ (`cmd mcp add-json` / `cmd mcp remove`)
because the directory it lives in is a slug of the workspace path that only the
CLI knows how to spell.

## The RPC surface

One `RpcGroup` (`OpenAdeRpcGroup` in `packages/contracts/src/rpc.ts`) carried
over the WebSocket with JSON serialization. Every RPC fails with the single
`OpenAdeRpcError` — `not-found | invalid | unavailable | conflict | internal` —
except `fs.browse`, which has its own error because the picker offers a
different next step for each reason. `PROTOCOL_VERSION` is 1; a mismatch puts
the client in the terminal `incompatible` state.

| Method                        | Kind   | What it does                                                                        |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `server.hello`                | call   | Protocol version and `serverInstanceId` — a new id means cached snapshots are stale |
| `orchestration.dispatch`      | call   | Takes the whole `Command` union, returns a `CommandReceipt`                         |
| `projects.list`               | call   | Project rows for the sidebar                                                        |
| `threads.list`                | call   | Thread summaries, optionally per project, optionally with archived                  |
| `threads.subscribe`           | stream | One thread: snapshot or catch-up from `afterSequence`, then live                    |
| `threads.listSubscribe`       | stream | The thread list, same shape                                                         |
| `connectors.list`             | call   | Configured connectors with their cached probes; `refresh` re-probes                 |
| `connectors.models`           | call   | The model picker's options for one instance                                         |
| `connectors.describe`         | call   | Every connector the build ships: metadata and config form, configured or not        |
| `files.search`                | call   | The composer's `@` file search                                                      |
| `files.read`                  | call   | A window of one file, with a `truncated` flag                                       |
| `fs.browse`                   | call   | Subfolders of one directory on the server's machine, for the folder picker          |
| `attachments.stage`           | call   | Uploads one composer image; returns a reference, never echoes bytes                 |
| `attachments.read`            | call   | Reads a staged image back for a thumbnail                                           |
| `git.status`                  | call   | Branch, ahead/behind and changed paths                                              |
| `git.diff`                    | call   | Worktree against HEAD, or between two checkpoint refs                               |
| `checkpoints.list`            | call   | Checkpoints that still exist as refs, intersected with the log's list               |
| `browser.subscribe`           | stream | The browser pane's state, and frames when the browser is ours                       |
| `browser.humanInput`          | call   | A human gesture into the browser the agent is driving                               |
| `settings.get`                | call   | The settings document                                                               |
| `settings.update`             | call   | Applies a patch, returns the new document                                           |
| `settings.subscribe`          | stream | The settings document as it changes                                                 |
| `connectors.skills.list`      | call   | Skills one instance loads, user scope plus an optional project                      |
| `connectors.skills.available` | call   | Shared-folder skills that instance does not load yet; empty when it offers none     |
| `connectors.skills.link`      | call   | Links one of those into the instance's user skills                                  |
| `connectors.mcp.list`         | call   | MCP servers in one instance's harness config, user and project scope                |
| `connectors.mcp.add`          | call   | Adds or replaces one entry we own; refuses one we do not                            |
| `connectors.mcp.remove`       | call   | Removes one entry we own                                                            |
| `keybindings.get`             | call   | The keybinding list                                                                 |
| `keybindings.update`          | call   | Replaces it                                                                         |

Reads that must stay fresh are streams rather than polls, and every stream can
end in `resnapshot-required`.

Two loopback HTTP routes ride the same server besides `/ws` and `/healthz`:
`POST /hooks/pretooluse` and `POST /mcp`. Each refuses a request whose `Origin`
header is present and is not loopback (`apps/server/src/rpc/origin.ts`) before
the bearer is even looked at. `Origin: null` is explicitly _not_ treated as "no
origin": an opaque origin is what a sandboxed iframe, a `data:` document and a
`file:` page send.

The marker page `GET /browser/attach/:threadId` rides along on the same router
and is neither authenticated nor origin-checked: it is a static page that names
the thread a webview belongs to, reads nothing and returns nothing that is not
already in its own URL.

## The hook bridge

A harness gates its tool calls one of two ways, and OpenAde supports both:

- **The hook bridge**, for a harness with shell hooks. The harness runs a
  script before each tool call; the script posts to our loopback bridge and
  blocks on the answer. Command Code works this way, and the rest of this
  section is that path.
- **The direct path**, for a harness driven over an SDK or JSON-RPC, where the
  harness asks its host — a permission callback, an approval request on the
  wire. The connector answers it in-process and needs no endpoint.

Both end in the same helper, `makeApprovalGate` in
`packages/connector-sdk/src/approvalGate.ts`. Its `decide` calls
`services.permissions.decide`; `allow` and `deny` return at once and emit
nothing, while `prompt` emits `request.opened`, parks until `respond` answers
(the connector wires it to `SessionHandle.respondToRequest`), and emits
`request.resolved`. `releaseAll` answers every parked request when the process
that asked has gone, so no card outlives its session. A defect inside
`decide` is answered as a prompt, never as allow. The hook bridge's
`hookAnswers.ts` is a thin adapter over the gate: a hook post in,
`hookSpecificOutput` out.

Command Code's PreToolUse hook is how a tool call becomes an approval card.

```
cmd child ──► ~/.openade/bin/cmd-hook.mjs   (system shell, per tool call)
                 │  reads the hook payload on stdin
                 │  reads the bearer from OPENADE_HOOK_TICKET_FILE
                 ▼
          POST /hooks/pretooluse   (loopback, Authorization: Bearer …)
                 │
             HookBridge.answer(token, body)
                 │  token → thread → the session's registered handler
                 ▼
          permission ladder ──► allow | deny  → answered immediately
                           └──► prompt ──► request.opened ──► card
                                              (parks until the user answers)
                 │
                 ▼
          hookSpecificOutput printed back on stdout → the harness applies it
```

The bearer is the routing key and the capability in one: it is minted per
thread, lives only in the spawned process's world, and revoking it is
`unregister`. It arrives in a **file** named by `OPENADE_HOOK_TICKET_FILE`, not
in the environment, because the CLI redacts secret-shaped variable names out of
a hook's environment; the failure that taught us so is in
[command-code-connector.md](command-code-connector.md#the-ticket-file).

Every failure path in the script prints a `deny`: bridge down, timeout, garbage
response. The bridge itself answers `deny` for an unregistered thread, a failing
handler and a handler that exceeds 590 seconds — under the harness's 600-second
cap and the script's own 570-second fetch timeout. Bodies are capped at 1 MiB.
An unrecognised bearer is a 401.

One exception to deny-on-unreachable: the hook block we install in a project
outlives the session, so an interactive `cmd` run in that project invokes the
script with no `OPENADE_HOOK_URL`. That run belongs to the user, so the script
exits cleanly with no output and the harness uses its own prompt flow.

Journaling is the event log, not a side channel: a `prompt` decision emits
`request.opened`/`request.resolved`, which ingestion persists as
`thread.approval.*`.

## The MCP gateway and the browser

`McpGateway` (`apps/server/src/mcp/McpGateway.ts`) is a loopback `POST /mcp`
JSON-RPC endpoint with a per-session bearer, minted for a thread and revoked
when the session ends or the thread closes. `GET /mcp` answers 405 — this
transport has no server-initiated stream. Protocol version negotiation echoes
the client's version when it is one the gateway speaks (`2025-06-18`,
`2025-03-26`, `2024-11-05`) and otherwise answers with ours.

`tools/list` serves the `browser_*` catalogue from
`apps/server/src/browser/tools.ts`: `browser_open`, `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_wait`, `browser_get`, `browser_screenshot`,
`browser_eval`, `browser_tabs`. Each entry carries its JSON Schema,
annotations, the agent-browser argv the call maps to, whether the call can move
the page, and an input budget — how many pointer/key/wheel gestures the call is
expected to synthesize itself.

`tools/call` goes through `BrowserService.callTool`, which owns the serialized
per-thread queue and the human-control epoch. Human input bumps the epoch,
except for input classes an in-flight call is expected to produce (a
`browser_click` produces one pointer event; a `browser_type` produces one key
event per character). A call that settles under a different epoch than it
started returns `interrupted_by_human`, which the agent reads in the tool
result. Results are capped at 64 KiB counted in bytes, cut on a byte boundary.

Timeline rows for `mcp__openade__browser_*` come from the harness transcript
through the connector's translator, not from the gateway — emitting items there
would double every row.

The browser itself is the `agent-browser` CLI, wrapped rather than mounted as
its own MCP server: wrapping is what gives a session per thread, a pinned
target, the interrupt rule and teardown on thread close. Every call is one
`--json` invocation whose envelope is `{ success, data, error }`.

Two modes (`apps/server/src/browser/driver.ts`), opened lazily on first use so
opening the pane never launches Chrome:

- **cdp-attach** — `OPENADE_CDP_PORT` is set, so the desktop launched with
  remote debugging. The driver binds the pane's own webview guest through
  agent-browser's CDP mode and pins the tab, so a destroyed pane reports
  `tab_gone` rather than silently driving another target. Human input lands in
  the guest directly.
- **owned-chromium** — no CDP endpoint, or no webview target inside the attach
  window: agent-browser runs its own headless Chrome and the driver streams
  JPEG frames over the session's WebSocket and forwards human input into it.
  Every gesture on that pane is human by construction — the agent cannot click
  an `<img>` — so each one bumps the epoch.

The remote-debugging port is opt-in for a reason: anything else running as this
user can drive the renderer through it. The shell opens one only when the
browser pane is enabled — `browserPane: true` in `desktop.json`, or the
`OPENADE_BROWSER_PANE` / `OPENADE_CDP_PORT` overrides, with
`OPENADE_REMOTE_DEBUG=0` as a veto — and with no port every thread runs
owned-chromium.

A missing `agent-browser` binary is not fatal: the service reports no binary,
every call fails with `AgentBrowserUnavailable`, and the pane renders an install
prompt.

## Permissions

The ladder (`apps/server/src/permissions/PermissionService.ts`) is pure and
takes everything it needs as arguments:

1. A matching `deny` rule → **deny**.
2. `interactionMode: "plan"` and the request is not a read → **deny**. Plan mode
   is read-only.
3. The request touches a sensitive path → **prompt**. "Ask" outranks allow: a
   remembered `allow` can never skip the secrets check.
4. A matching `allow` rule → **allow**.
5. A read → **allow**.
6. Runtime mode decides the rest: `approval-required` asks;
   `auto-accept-edits` allows writes but still asks for commands and network;
   `full-access` allows everything that got this far.

The sensitive-path check covers a file request's path, every argument of a
command line, and the path or `file:` URL of anything else — including MCP
tools. Without that last clause, `browser_open` on a `file:` URL followed by
`browser_get` read key material with no card shown, where `read_file` on the
same path prompts. The list (`sensitivePaths.ts`) is about credentials
specifically: `.env*`, `.netrc`, `.pgpass`, `credentials`, SSH key names,
`.pem`/`.key`/`.p12`/`.pfx`, and anything under `.ssh`, `.aws`, `.gnupg`,
`.git`, `.config/gh`, or a harness config home — `.commandcode`, `.claude`,
`.codex`, `.config/opencode` — since those hold auth tokens and the harness's
own permission settings.

**Pattern syntax** (`packages/shared/src/permissionPattern.ts`). The
vocabulary is OpenAde's own, the same whichever harness runs the thread; each
connector maps its harness's tool names onto it when it proposes a rule:

| Form                     | Matches                                                   |
| ------------------------ | --------------------------------------------------------- |
| `Shell(npm run *)`       | a command glob; `*` matches anything, `?` one char        |
| `Edit(/src/**)`          | a write's path glob; `**` crosses separators, `*` doesn't |
| `Read(/docs/**)`         | the same, for reads                                       |
| `Fetch(https://x.dev/*)` | a web request's url or search query                       |
| `Mcp(github.create_*)`   | an MCP call's `server.tool`, from the request's `mcpTool` |
| `todo_write`             | a bare tool name, exact or glob                           |

Rules stored in the older spelling stay valid as aliases: `Write(…)` is
`Edit(…)`, `WebFetch(…)` and `WebSearch(…)` are `Fetch(…)`, and a literal
`mcp__server__tool` is still globbed against an MCP request's tool name.

The subject a pattern tests comes from the request's `kind`, `input` and
`mcpTool` (optional on `ApprovalRequest`, since requests persisted before it
existed lack it).

Rules live in `permission_rules`, scoped `global | project | session`, with
`project_id`/`thread_id` stored as `''` rather than NULL so the uniqueness
constraint dedupes. That table is the single source of truth; the wire
`Settings.permissions` array is a projection of it, and the stored settings
document keeps its own copy of that array empty, so the two can never disagree. "Allow always" writes a row
inside the dispatch transaction and, after commit, invalidates the reactive key
so an open settings page re-reads it — after, because a subscriber told to
re-read mid-transaction can see a row the rest of the dispatch then rolls back.

A failure inside a permission decision is logged and answered `prompt`: a
permissions failure must never read as allow.

Connectors reach the ladder only through `ConnectorServices.permissions`, on
either approval path ([the hook bridge](#the-hook-bridge)): the hook bridge's
adapter and a direct-path connector both hand their request to the approval
gate, which asks the ladder and, on `prompt`, opens the card.

## On disk

`~/.openade` unless `OPENADE_HOME` says otherwise
(`packages/shared/src/paths.ts`). `boot` sets that variable process-wide before
anything resolves a path, and connector children inherit it.

| Path                                 | What it is                                  |
| ------------------------------------ | ------------------------------------------- |
| `~/.openade/state.sqlite`            | the event log, projections, settings, rules |
| `~/.openade/bin/cmd-hook.mjs`        | the generated PreToolUse hook script        |
| `~/.openade/bin/tickets/<id>.ticket` | a session's hook bearer, 0600               |
| `~/.openade/attachments/<threadId>/` | staged composer images                      |
| `~/.openade/dev/connection.json`     | the dev handshake, 0600, dev mode only      |

Attachments are references, never bytes, in the event log: an inlined screenshot
would be re-sent on every replay and to every client. The bytes cross the wire
twice — once up in `attachments.stage`, once down per thumbnail in
`attachments.read`. The media type is sniffed from the file's own header on the
way in and the way out, never taken from the name or the browser's claim, and
every path is resolved and checked against the thread's own directory before it
is touched. `AttachmentReactor` purges a thread's directory on
`thread.deleted` — not on archive, since an archived thread can be reopened —
and sweeps files no thread references at boot, with an hour's grace so a file
the previous process staged just before it went away survives.

The harness's own home (`~/.commandcode` by default) is separate and is _not_
moved by `OPENADE_HOME`; `BootOptions.commandCodeHome` exists so an end-to-end
test that adds an MCP server does not edit the operator's real config.

## Tests and the gate

One command is the gate — `pnpm check`: lint, format, types, tests, boundaries,
file sizes, dead code. What each stage enforces and how to run one on its own is
in [development.md](development.md#the-gate).

Unit suites sit beside their subjects in every workspace. Above them:

- **Contract lockstep tests** keep each `*Type` literal list and its union in
  agreement, so a variant cannot be added to one without the other.
- **The decider table** drives `decide` with fixed ids and a fixed clock, which
  is why a scripted conversation replays byte-identically.
- **The conformance suite** runs against the real connector definition.
- **The end-to-end suite** (`apps/server/test/e2e/`) builds the product: `boot`
  assembles the same graph `main.ts` ships, the real client runtime dials it
  over a real WebSocket, and the renderer's own folds turn the subscription into
  the view a pane renders. Ten scenarios — `turn`, `approval`, `question`,
  `plan`, `interrupt`, `resume`, `checkpoints`, `attachment`, `mcp`,
  `settings`. Nothing waits on a clock: commands are awaited through their
  receipts and everything else through the subscription, so a scenario that
  never happens ends as a failed wait rather than a slow pass.

The end-to-end suite and the live conformance test have two drivers, differing
only in the binary: the gate runs recordings through
`packages/testkit/bin/replay-cmd.mjs`, and `OPENADE_LIVE_CMD=1` runs the
operator's own `cmd`. [development.md](development.md#the-end-to-end-suite) has
the commands and how a recording is made.

`pnpm build` produces the server bundle, the web `dist` and the macOS app
through electron-builder. `apps/server`'s esbuild entry is
`apps/server/src/main.ts` and nothing under a `test/` directory is bundled,
which is the other half of why the boundary check keeps testkit out of the
production allowlist.
