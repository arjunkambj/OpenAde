# Development

How to install, run, test, check and package OpenAde. Every command here is one
the workspace actually defines — the root `package.json` scripts, a workspace's
own scripts, or a script under `scripts/` — and every path is relative to the
repository root. For what the pieces are, read
[architecture.md](architecture.md); for what they do at runtime,
[how-it-works.md](how-it-works.md); for the rules the checks enforce,
[philosophy.md](philosophy.md).

## Prerequisites

| Thing            | Version                     | Where it is written                    |
| ---------------- | --------------------------- | -------------------------------------- |
| Node             | `>=22.16`                   | `package.json` `engines.node`          |
| pnpm             | `11.21.0`                   | `package.json` `packageManager`        |
| Command Code CLI | whatever you have installed | `packages/connector-cmd/src/binary.ts` |
| git              | any                         | checkpoints shell out to it            |

pnpm comes from the `packageManager` field, so `corepack enable` is enough; CI
does exactly that and pins only the Node major (`node-version: "22"` in
`.github/workflows/ci.yml`).

The app drives the Command Code CLI, so a working `cmd` is a prerequisite for
anything past the first screen. `resolveBinary` in
`packages/connector-cmd/src/binary.ts` looks for it in this order:

1. the `binaryPath` configured on the connector instance,
2. `cmd` on `PATH`, then in `/usr/local/bin`, `/opt/homebrew/bin`,
   `~/.bun/bin`, `~/.local/share/pnpm`, `~/.npm-global/bin`,
3. `npx -y command-code@latest`.

Log in once with `cmd login`; the connector's probe reads `cmd status --json`
for auth, account and version, and `cmd --list-models` for the model picker
(`packages/connector-cmd/src/probe.ts`). Nothing is pinned to a CLI release:
`OLDEST_TESTED_VERSION` (`1.54.0`) is only the floor the probe warns below.

The browser pane needs `agent-browser` on `PATH`, or `OPENADE_AGENT_BROWSER`
pointing at it (`apps/server/src/browser/agentBrowser.ts`). Without it the pane
renders an install prompt instead of failing the app.

## Install

```sh
pnpm install
```

`pnpm-workspace.yaml` allows post-install builds only for `electron` and
`esbuild`; `msgpackr-extract` is deliberately left unbuilt so a checkout never
needs a C++ toolchain. CI installs with `--frozen-lockfile`.

## Running it

```
pnpm dev
 ├── turbo run dev -F web      → vite dev on http://localhost:3001 (strictPort)
 └── apps/desktop/scripts/dev.mjs
      ├── esbuild --watch  main | preload | ../server/src/main.ts
      └── electron apps/desktop  (ELECTRON_RENDERER_URL=http://localhost:3001)
           └── ServerSupervisor spawns the server as a child
                <electron> --import <tsx loader> apps/server/src/main.ts
                ELECTRON_RUN_AS_NODE=1  OPENADE_DEV=1
                handshake { url, token, serverInstanceId } on fd 3
```

`pnpm dev` is `turbo run dev:hmr -F desktop`, which is `concurrently` over the
Vite dev server and `apps/desktop/scripts/dev.mjs`. The desktop shell owns the
server process: `ServerSupervisor`
(`apps/desktop/src/backend/ServerSupervisor.ts`) spawns it, reads the bootstrap
handshake off fd 3, and restarts it with 500 ms → 10 s backoff, pausing after
five consecutive failures. Both in dev and when packaged the child is
`process.execPath` — the Electron binary — run with `ELECTRON_RUN_AS_NODE=1`
(`apps/desktop/src/backend/serverDeps.ts`). In dev its argv is
`--import <tsx loader> apps/server/src/main.ts` rather than the `tsx` CLI, so
the server stays a direct child and fd 3 survives
(`apps/desktop/src/backend/serverArgs.ts`). Unpackaged, it also gets
`OPENADE_DEV=1`, so a desktop dev run writes the dev connection file too.

There is no root `dev:server` script. The other useful entry points:

| Command                 | What it starts                                        |
| ----------------------- | ----------------------------------------------------- |
| `pnpm dev`              | desktop shell + web dev server + supervised server    |
| `pnpm dev:desktop`      | the same thing (`turbo run dev:hmr -F desktop`)       |
| `pnpm dev:web`          | the Vite dev server alone                             |
| `pnpm -F server dev`    | `tsx watch apps/server/src/main.ts --dev`             |
| `pnpm -F desktop start` | builds web, bundles, runs Electron without watch mode |

### Running the renderer in a browser

`pnpm dev:web` alone has no server to talk to. Start one in dev mode in a
second terminal:

```sh
pnpm -F server dev
```

`--dev` makes the server also write `~/.openade/dev/connection.json`
(`apps/server/src/rpc/bootstrap.ts`, mode 0600 in a 0700 directory). The Vite
config serves that file at `GET /__openade/connection`, refusing cross-origin
reads (`apps/web/vite.config.ts`), and the client resolver dials it
(`packages/client-runtime/src/resolver.ts`). The resolution order the renderer
uses is: the Electron preload bridge, then that dev endpoint, then
`?server=<url>&token=<t>` on the query string.

The file holds a bearer token for a socket that accepts
`orchestration.dispatch`. Treat it as a credential.

### OPENADE_HOME

`OPENADE_HOME` moves every path the app owns — the database, the attachments
directory, the generated hook script, the dev connection file
(`packages/shared/src/paths.ts`). Use a scratch home whenever you are running a
dev build, so an experiment cannot corrupt the real `~/.openade` or make the
desktop app and the dev loop fight over one `state.sqlite`:

```sh
OPENADE_HOME=/tmp/openade-scratch pnpm dev
```

`turbo.json` lists it under `globalPassThroughEnv`, because turbo otherwise
hands a task a filtered environment and the variable would reach neither the
server nor the Vite plugin. `boot()` sets it process-wide when it is given a
`home`, so spawned connector children inherit it (`apps/server/src/boot.ts`).

Other environment knobs the server itself reads: `OPENADE_PORT` (default `0`,
meaning ask the OS), `OPENADE_DEV=1` (same as `--dev`).

## The gate

```sh
pnpm check
```

is `lint → fmt:check → typecheck → test → check:boundaries → check:file-sizes →
knip`, and it is what CI runs on Ubuntu and macOS. Each stage runs alone too:

| Stage      | Command                 | What it enforces                                                                    |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------- |
| lint       | `pnpm lint`             | oxlint: `correctness` as error, `no-explicit-any`, the shadcn rules                 |
| format     | `pnpm fmt:check`        | oxfmt over the tree, the markdown in `docs/` included; `pnpm fmt` writes            |
| types      | `pnpm typecheck`        | `tsc --noEmit` per workspace; web also runs `vite build`                            |
| tests      | `pnpm test`             | `turbo run test` → `vitest run` per workspace                                       |
| boundaries | `pnpm check:boundaries` | import allowlist, connector leaks, neutrality, reference names, barrels, bold icons |
| file sizes | `pnpm check:file-sizes` | 800 lines a file, 400 for a renderer component                                      |
| dead code  | `pnpm knip`             | unused files, exports and dependencies                                              |

`pnpm typecheck` and `pnpm check-types` are the same script.

### Boundaries

`pnpm check:boundaries` first runs the rules' own tests
(`scripts/boundary-rules.test.mjs`, with `scripts/vitest.config.mjs`), then
`scripts/check-boundaries.mjs`, which does six things in one pass over the
tree. The rules are pure functions in `scripts/boundary-rules.mjs`; the script
only walks and reports.

**Import allowlist.** Every import that names another workspace package is
checked against a table in `boundary-rules.mjs` — the table is reproduced in
[architecture.md](architecture.md#boundaries). A relative specifier that climbs
out of its own workspace directory is a violation whatever it lands on, because
packages are consumed through their `exports` map.

A workspace with no rule may import no workspace package at all; add the rule
before the import. Test files in `apps/server` get four extras — `testkit`,
`client-runtime`, `connector-cmd` and `connector-claude` — which is what keeps
an accidental import of any of them out of `src/main.ts`, since that file is
bundled for packaging. Test files in `packages/connector-claude` get `testkit`,
because they replay the connector's recordings through its `sdk-stream`
replayer and record them through its tee; the connector's sources never import
it. One production file gets extras of its own: `apps/server/src/boot.ts`, the
composition root, may import `connector-cmd` and `connector-claude`. A file
counts as a test when it ends in `.test.`/`.spec.` or sits under a `test/`
directory.

**Connector leaks.** Non-test sources under `apps/web`, `packages/client-runtime`
and `apps/server` name no concrete connector: they import no `@OpenAde/connector-*`
package other than `connector-sdk`, and contain no quoted connector kind —
`"cmd"`, `"claude"`, `"codex"` or `"opencode"`, in any quote style. Tests and
`apps/server/src/boot.ts` are exempt, because they assemble the real connector
on purpose. One file is exempt from the kind rule by exact path,
`packages/client-runtime/src/keybindings.ts`, where `"cmd"` is the Command key
of a shortcut; the reason sits next to the path in `KIND_LITERAL_EXEMPT`. A
harness config path such as `".claude"` or `".config/opencode"` is not a kind
and passes.

**Renderer neutrality.** Connector identity never reaches `apps/web/src`: the
patterns `command code` (spaced or not), the literal `"cmd"`, and `claude`,
`codex` and `opencode` as words are refused anywhere under it, in file names as
well as contents. One path is exempt, `apps/web/src/components/ui/icons`, so a
connector's own logo can be shipped under its own name; nothing lives there
today.

**Reference names.** The products OpenAde was compared against while it was
built are never named — not in `apps/`, `packages/`, `scripts/` or the
top-level `docs/*.md`, in file names or contents, in any case. `docs/plans/`
(local, gitignored), `node_modules`, `dist`, `out` and the recorded fixtures
under `packages/testkit/fixtures/` are skipped; the hand-written contract
fixtures are read like any source. The guard holds the names base64-encoded so
that it does not spell them itself, and its tests build their inputs from the
same list. Describe an idea you took from elsewhere in our own words.

**No barrels.** An `index` module anywhere under `packages/` is refused —
`.ts`, `.tsx`, `.js`, `.jsx` or `.mjs`; each package exports one entry per
module through its `exports` map. Apps are exempt — a router `index.tsx` is a
route, and the Electron entry points are named by electron-builder.

**Bold icons.** Icons render the bold variant app-wide. `@honeyicons/react`
draws every icon linear unless told otherwise and has no provider for a
default, so each element spells it: a `.tsx` file under `apps/` or `packages/`
that renders a component imported from `@honeyicons/react` without
`variant="bold"` fails, and the message says to add it. The rule reads the
file's imports from the package (aliases included, type-only imports left out)
and each JSX opening of one of those names, across as many lines as it spans.
An element that spreads props (`<Bell {...props} />`) passes, so a wrapper that
forwards props must pass `variant="bold"` through them. An icon handed around
as a value — a `HoneyIcon` prop, an icon map, a nav item's `icon` — is outside
the rule's reach; render it as `<item.icon variant="bold" />` too. Line-only
icons such as arrows and chevrons draw the same in both variants and take the
prop anyway, so no icon is a special case.

### File sizes

`scripts/check-file-sizes.mjs`: 800 lines for any source file under `apps/`,
`packages/` or `scripts/`, and 400 for anything under
`apps/web/src/components`. Exempt: `.test.`/`.spec.` files, `*.gen.ts`,
`routeTree.gen.ts`, and the two fixture roots
(`packages/contracts/fixtures`, `packages/testkit/fixtures`) — skipped by path,
not by directory name.

### knip and `@public`

Packages are consumed as TypeScript source, so every `exports` entry is an entry
point and by default every symbol a package exports counts as used. Each
`packages/*` workspace therefore sets `includeEntryExports` — knip reads inside
the entry files — together with `ignoreExportsUsedInFile`, so a schema that is
exported and also composed further down its own module is not reported.

`knip.json` sets `"tags": ["-@public"]`, so an export whose JSDoc carries
`@public` is exempt from the dead-export report. Use it for the seams a
composition root or a test drives rather than a caller in the same graph —
`boot`'s options and result, the layers `main.ts` wires
(`apps/server/src/boot.ts`, `apps/server/src/persistence/Sqlite.ts`,
`apps/server/src/settings/connectorRouting.ts`). Everything else that nothing
imports is dead code, and knip says so.

knip reads `apps/web/src/routeTree.gen.ts`, which is gitignored and written by
`vite build`. Run `pnpm typecheck` (or `pnpm build`) before `pnpm knip` on a
fresh checkout. `turbo.json` declares that file as an output of
`web#check-types` so a cache replay puts it back.

## Test conventions

Vitest, one project per workspace, collected by the root `vitest.config.ts`
(`packages/*`, `apps/server`, `apps/desktop`, `apps/web`). `pnpm test` runs
them through turbo; `pnpm exec vitest run <path>` runs one file from the root.

**Nothing waits on a clock.** Every write in OpenAde is a command and every
command comes back as a `CommandReceipt` carrying the event-log position its
effects are visible at, so "did my write land?" is answerable exactly. Tests
record receipts and await the one they care about by `commandId`
(`packages/testkit/src/receipts.ts`); streams are awaited through
`makeStreamCollector`'s `awaitItem`
(`packages/connector-sdk/src/streamCollector.ts`). A scenario that never
happens ends as a failed `awaitItem`, not a slow pass. Where a test genuinely
needs time to move, it uses Effect's `TestClock`
(`apps/server/src/orchestration/LiveBuffer.test.ts`).

**Fixtures are the contract made concrete.** `packages/contracts/fixtures/`
holds one JSON file per `RuntimeEvent` variant, per `ItemKind`, per `Command`,
per `OrchestrationEventType`, per stream frame, per read model and per RPC
result. `packages/contracts/test/fixtures.test.ts` decodes each one and encodes
it again, and the result must equal the bytes on disk. The coverage cases
derive their lists from the schemas, so adding a variant without a fixture
fails, and a fixture nothing round-trips fails too. The renderer's own tests
read the same files (`apps/web/src/lib/turn.test.ts`).

**Connectors run a shared suite.** `runConnectorConformance`
(`packages/connector-sdk/src/conformance.ts`) drives a real definition through
`createInstance`/`startSession`/`send`/`close` and holds it to the five promises
listed in [architecture.md](architecture.md#the-conformance-suite). A new
connector's test file is one call to it.
`packages/testkit/src/fakeConnector.ts` is the fake that exercises the SDK
interface itself.

**The CLI is never invented.** Anything a test needs to know about a harness
comes from a recording of it under `packages/testkit/fixtures/<kind>/`, where
`<kind>` is the connector kind that drives it. Command Code's are under
`fixtures/cmd/` and replayed by `packages/testkit/bin/replay-cmd.mjs`. See
[Recordings](#recordings-of-the-real-cli).

## The end-to-end suite

`apps/server/test/e2e/` boots the product: `boot()` assembles the same graph
`main.ts` ships, `makeConnection` from `@OpenAde/client-runtime` dials it over
a real WebSocket, and the folds the renderer's atoms use turn the subscription
into the view a pane renders. Ten scenarios:

| File                  | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `turn.test.ts`        | a turn, from `project.create` to the answer on screen |
| `approval.test.ts`    | the approval gate, all three answers                  |
| `question.test.ts`    | the model asks the user a question                    |
| `plan.test.ts`        | plan mode, accepted and revised                       |
| `interrupt.test.ts`   | Stop, and what the thread does next                   |
| `checkpoints.test.ts` | two editing turns, two checkpoints, and a restore     |
| `resume.test.ts`      | the server dies mid-thread and comes back             |
| `settings.test.ts`    | the settings pages, against the user's real files     |
| `attachment.test.ts`  | an image on a turn                                    |
| `mcp.test.ts`         | OpenAde's own tools, offered to the harness           |

Each scenario runs against two drivers (`apps/server/test/e2e/harness.ts`):

- **replay** — the connector's `binaryPath` points at testkit's replayer, which
  puts a recording of that run back on the wire. This is what the gate runs.
- **live** — the connector discovers your own `cmd` and spends your plan.
  Skipped unless `OPENADE_LIVE_CMD=1`.

```sh
pnpm exec vitest run apps/server/test/e2e              # replay only
OPENADE_LIVE_CMD=1 pnpm exec vitest run apps/server/test/e2e
```

The same assertions run twice, which is the point: the replay says the product
behaves, and the live run says the recording still describes reality. A
scenario that needs different expectations from the two drivers is a scenario
whose recording has gone stale.

Every test gets a fresh `OPENADE_HOME` and a throwaway git repo under the
system temp directory. The replay driver also redirects `HOME`, so it cannot
touch `~/.commandcode`; the live driver deliberately does not, because that is
where the CLI's credentials live. Both redirect `commandCodeHome` so the
settings scenario edits a copy rather than your real `~/.commandcode/mcp.json`.

The live conformance suite is separate and cheaper — about six turns:

```sh
OPENADE_LIVE_CMD=1 pnpm exec vitest run apps/server/src/hooks/cmdLiveConformance.test.ts
```

`OPENADE_LIVE_CMD_MODEL` overrides the model, `OPENADE_LIVE_CMD_DEBUG=1` adds
output. The browser equivalent is `OPENADE_LIVE_BROWSER=1` over
`apps/server/src/browser/live.test.ts`, which spawns a real Chromium.

### The Claude Code end-to-end suite

`apps/server/test/e2e-claude/` is the same product-level suite on the Claude
Code connector. It reuses the Command Code harness's homes, client, commands
and view readers, and adds three drivers (`apps/server/test/e2e-claude/harness.ts`):

- **replay**, the default and what the gate runs: the instance's `binaryPath`
  is the `sdk-stream` replayer for the scenario's recording in
  `packages/testkit/fixtures/claude/`. A green run must also have played its
  recording out as recorded: the replayer appends any divergence to a log the
  harness checks after the scenario, so a divergence the connector absorbed
  still fails it.
- **live**, `OPENADE_LIVE_CLAUDE=1`: the connector discovers your own `claude`
  and spends your subscription. `OPENADE_LIVE_CLAUDE_CONFIG_DIR` points the
  instance at a separate account (its `configDir`, which sets
  `CLAUDE_CONFIG_DIR`; `HOME` is never redirected).
- **record**, `OPENADE_RECORD_CLAUDE=1`: live through the stdio tee. When the
  scenario passes and its scope has closed, the capture is finalised into
  `fixtures/claude/<scenario>/` with the CLI version from the connector's own
  probe, the SDK version from the package the connector imports, and the model
  the CLI's `system/init` named. A recording run runs the record driver only.

```sh
pnpm exec vitest run apps/server/test/e2e-claude           # replay
OPENADE_LIVE_CLAUDE=1 pnpm exec vitest run apps/server/test/e2e-claude
OPENADE_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts
```

A replay runs no tool — the recording stands in for the CLI — so what a
tool did to the workspace (the file an allowed write made, the file a denied
command did not) is checked by the live and record drivers; a replay checks
the thread: the cards, their answers, and the rows.

| File                 | Recording               | Scenario                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------ |
| `signed-out.test.ts` | `signed-out-turn`       | a turn against a signed-out CLI: the probe and the error row |
| `turn.test.ts`       | `plain-reply`           | a turn, from `project.create` to the answer on screen        |
| `interrupt.test.ts`  | `interrupt`             | Stop after the first text, then the next message             |
| `resume.test.ts`     | `resume`                | the server restarts and the conversation goes on             |
| `approval.test.ts`   | `edit-approval`         | a write asked about, then allowed once                       |
| `approval.test.ts`   | `deny`                  | a command denied, and the file it would have made absent     |
| `approval.test.ts`   | `sensitive-full-access` | `cat .env` under full access still opens a card              |
| `plan.test.ts`       | `plan-accept`           | the plan card, then the accepted plan implemented            |
| `question.test.ts`   | `question`              | the question card, and the answer written to `colour.txt`    |

A scenario whose recording has not been made yet is skipped under replay, and
its title says so. `packages/testkit/fixtures/claude/README.md` lists which
those are.

Every driver runs the thread on the CLI's default model (thread model
`default`, which leaves the SDK's `model` option out) and every session under
`CLAUDE_LIMITS` (four turns, fifty cents), passed to the connector through
`BootOptions.claudeCode`. A replay runs under the same caps, so its argv is the
recorded one. The live and record drivers refuse any other thread model unless
it is named in `OPENADE_CLAUDE_APPROVED_MODEL`. Replays and live runs make
their homes under the system temp directory; a recording makes them, and keeps
its raw capture, under `/tmp/openade-h1`.

The connector's own suites replay the same fixtures without a server:
`recordedFrames.test.ts` feeds every recorded session through the translator
and fails on any frame it leaves unmapped; `recordedSession.test.ts` replays
the session launch of `plain-reply`, the approval scenarios, `plan-accept` and
`question`; `conformance.test.ts` runs
`runConnectorConformance` against `conformance`, which is the suite itself
recorded through the tee, one session launch per case
(`OPENADE_RECORD_CLAUDE=1` on that file re-records it).

### Which models cost money

`cmd --list-models` offers about seventy and most of them bill the account.
Three are authorised in the code, and both the recorder and the live suites
refuse anything else:

| Model                                   | Note                                         |
| --------------------------------------- | -------------------------------------------- |
| `meta/muse-spark-1.3-contributor`       | the account default; cheap, good at tool use |
| `poolside/laguna-s-2.1-free`            | free tier                                    |
| `inclusionai/ling-3.0-flash-sante:free` | free tier                                    |

The end-to-end suite runs on the first of these (`E2E_MODEL`), which is also
the model every recording was made on.

## Recordings of the real CLI

`packages/testkit/fixtures/cmd/` holds one directory per scenario, each a real
run of the real CLI — argv, stdout with its chunk boundaries, stderr, the
on-disk transcript as it grew, the checkpoints file, every PreToolUse
invocation with both halves of the conversation, the plan files and the files
the turn touched. Nothing in it is hand-written, and it is never edited to make
a test pass. `packages/testkit/fixtures/cmd/README.md` is the index and the
scenario catalogue.

### The recording format

Every harness's recordings share one layout, defined in
`packages/testkit/src/recording.ts`: `packages/testkit/fixtures/<kind>/<scenario>/`
holds a `manifest.json` and the transport's own capture files beside it. The
manifest's common fields are `formatVersion` (currently
`RECORDING_FORMAT_VERSION = 1`), `kind`, `transport`, `scenario`,
`description`, `cliVersion`, `recordedOn`, `model` and `real: true`.
`readManifest(kind, scenario)` refuses a manifest that is not marked real or
names a format it cannot read. The Command Code manifests predate
`formatVersion` and `transport` and are never edited, so a manifest without
them reads as version 1 of its kind's legacy layout: for `cmd` that is
`stdio-ndjson`.

A `RecordedFrame` is one unit on the wire, tagged with its direction
(`from-harness` or `to-harness`), the channel it travelled on, an optional
timestamp and its data. `turnFrames` in `replayCmdProcess.ts` gives a Command
Code turn in that form: stdout frames and hook payloads from the harness, and
hook answers to it. A `Replayer` pairs a kind and transport with
`config(scenario, options)`, which returns what a connector instance needs to
talk to the recording instead of the harness. `cmdReplayer` wraps
`replayConfig`.

`RecordingTransport` also names the transports other connectors bring:
`stdio-jsonrpc`, `sdk-stream` and `http-sse`. A connector that speaks one of
them adds its recordings under its own `fixtures/<kind>/`, sets `transport` in
every manifest, and uses or adds a replayer for that transport. Only `cmd` has
a legacy layout: any other kind's manifest without `transport` is refused. The
existing recordings stay as they are. `fixturesRoot`, `recordingNames` and
`readManifest` take an optional root in place of `packages/testkit/fixtures`,
so the testkit's own tests write their captures to a temp directory.

#### sdk-stream

An SDK that drives its CLI over stdio NDJSON (messages, `control_request` and
`control_response` both ways) is recorded at the process boundary, so a replay
runs the real SDK and the real connector code with only the binary path
changed. Nothing in the testkit imports an SDK.

**Recording.** `makeTeeLauncher({ realBinary, rawDir })`
(`packages/testkit/src/sdkStreamRecording.ts`) writes a `#!/bin/sh` launcher
and its `config.json` into `rawDir`. The launcher runs `bin/stdio-tee.mjs`
with node named by absolute path, so it works under a connector's default-deny
environment. Point the connector's binary path at the launcher.

The tee spawns the real binary with the same argv, cwd and environment. It
stays in the tee's process group, so a connector that kills the group takes
both. The tee forwards SIGINT and SIGTERM and pipes all three streams through
unchanged. Every launch, a `--version` probe as much as a session, claims the
next number `n` and writes two files:

- `invocation-<n>.ndjson`: one `RecordedFrame` per line, appended
  synchronously, so a SIGKILL loses nothing already seen. A frame is
  `{ dir: "to-harness" | "from-harness", channel: "stdin" | "stdout" | "stderr", at, data }`,
  where `data` is the parsed JSON line, or the raw string when a line is not
  JSON.
- `invocation-<n>.json`: argv and cwd, plus the exit code and signal once the
  harness exits.

Environment values are never written.

`finalizeSdkStreamRecording({ kind, scenario, rawDir, description, cliVersion, sdkVersion, model, prompts })`
replaces `fixtures/<kind>/<scenario>/` with a `manifest.json` and the scrubbed
invocation files. The manifest carries the common fields with
`transport: "sdk-stream"`, plus `sdkVersion`, `prompts`, and `invocations[]`,
which lists each launch's scrubbed `argv` and `cwd`, its `file`, `exitCode` and
`signal`. `loadSdkStreamRecording(kind, scenario)` reads a recording back with
its frames.

**Replaying.** `sdkStreamReplayer(kind).config(scenario, { tmpDir, pidDir?, divergenceLog? })`
(`packages/testkit/src/replaySdkStream.ts`) returns `{ binaryPath }`: a
launcher written into `tmpDir` with the scenario baked in, because the
connector's environment is default-deny and cannot carry it.
`bin/replay-sdk-stream.mjs` behind it behaves as follows:

- **Choosing an invocation.** Each launch plays the first unplayed recorded
  invocation of the same argv class: `--version`, `auth status`, a probe's
  `stream-json` handshake (a run with `--no-session-persistence`), a session's
  `stream-json` run, or else the exact argv. A counter in `tmpDir` keeps count,
  so the second session of a resume-after-restart test plays the second
  recorded run whatever the probes did in between. A probe asked again — a
  handshake included — hears the last recorded answer again, because how often
  a server probes is its own business. A session launch with no recorded run
  left is a divergence.
- **Simple invocations** print their recorded stdout and stderr and exit with
  the recorded code.
- **Stream runs** walk the frames in order. A frame from the harness is written
  to its channel. At a frame to the harness, the replay blocks on the next line
  of stdin, so it never runs ahead of the live side. A test that triggers a
  mid-turn action (an interrupt, a steer) must trigger it on an event the
  recording emits before that action's frame.
- **Gating.** The live line must be the same move:
  - the same `type`;
  - for a `control_request`, the same `request.subtype`;
  - for a `control_response`, the same `response.subtype`;
  - when it answers a request the harness made, the same `request_id`, plus the
    same `behavior` for `can_use_tool` and the same `permissionDecision` for
    `hook_callback`.

  Answers to two open harness requests may arrive in either order, and each is
  still checked.

- **Id rewriting.** The SDK's own request ids (`initialize`, `interrupt`,
  `set_model`, `set_permission_mode`, …) are random. Each recorded id is mapped
  to the live one when it arrives, and the recorded `control_response` to it is
  rewritten to carry the live id.
- **Divergence is loud.** A line the recording does not have, stdin closing
  while the recording still expects input, or input after the recording has
  ended prints both sides to stderr and exits **97**. With `divergenceLog` it
  also appends them to that file: a connector keeps its child's stderr to
  itself, so a test checks the file to know a green run played the recording
  out as recorded.
- **Ending.** After the last frame the replay waits for stdin to close, then
  exits the way the recorded run did, by code or by signal. With `pidDir` it
  drops a pid file, so `isProcessGone` checks a real child.

The tests of the tee and the replayer
(`sdkStreamRecording.test.ts`, `replaySdkStream.test.ts`) drive an ordinary
node program written into a temp directory (`stdioCounterpart.ts`). It is no
harness and needs no harness binary.

### Making one

Recording spends the operator's paid plan, so it is never run from CI:

```sh
node packages/testkit/scripts/record-cmd.mjs --list
node packages/testkit/scripts/record-cmd.mjs shell-allow
node packages/testkit/scripts/record-cmd.mjs plan --model poolside/laguna-s-2.1-free
node packages/testkit/scripts/record-probe.mjs      # no model turns at all
```

The Claude Code recorders are vitest files, skipped unless
`OPENADE_RECORD_CLAUDE=1`. Scenarios that go through the server are recorded
by the end-to-end suite's record driver (see "The Claude Code end-to-end suite"
above); the connector-level ones are:

```sh
OPENADE_RECORD_CLAUDE=1 pnpm -F @OpenAde/connector-claude vitest run test/recordProbe.test.ts
OPENADE_HOME=/tmp/openade-h1 OPENADE_RECORD_CLAUDE=1 \
  pnpm -F @OpenAde/connector-claude vitest run test/recordSession.test.ts
OPENADE_RECORD_CLAUDE=1 pnpm -F @OpenAde/connector-claude vitest run src/conformance.test.ts
```

Each points the connector's `binaryPath` at the testkit's stdio tee, drives the
real definition — the probe, or a session in a throwaway git repo under
`/tmp/openade-h1/scratch` — and finalises the capture into
`fixtures/claude/<scenario>/`. Sessions run on the CLI's default model, capped
at one turn and five cents. `probe` and `signed-out` spend nothing: the first
sends no message, and the second was recorded while the CLI was signed out, so
the CLI refused the turn without calling the API.

`record-cmd.mjs` gives each run a throwaway git repo under a scratch root
(`RECORD_SCRATCH`, default the system temp directory), spawns the CLI through
the same binary resolution `probe.ts` uses and with the same argv and
environment `packages/connector-cmd/src/spawn.ts` builds, and installs the
recording hook through the same `.commandcode/settings.local.json` mechanism
`config.ts` uses. A `--model` outside the authorised list stops the run before
anything is spawned. `record-probe.mjs` captures the free surfaces —
`status --json`, `--list-models`, `--version`, `--help`, and the error a bad
`--model` produces.

### Scrubbing

Recordings are scrubbed on the way in: the scratch root becomes `<SCRATCH>`,
the home directory becomes `<HOME>`, the account name and the home directory's
basename become `user`, and anything token-shaped becomes `<REDACTED>`. Session
ids and trace ids are left alone — they are per-run identifiers with no meaning
off the machine, and the tests match on them. The replayer puts `<HOME>` and
`<SCRATCH>` back from the running process's own directories.

The `sdk-stream` finaliser adds more rules, because its captures carry the
account and the MCP bearer:

- The account's email, organisation name and ids, and account uuid are read out
  of the init, account and `auth status` payloads. They are replaced
  everywhere: emails become `user@example.com`, uuids the zero uuid, and names
  `<ACCOUNT>`. Any other email address becomes `user@example.com` too.
- A value under a credential key (`Authorization`, `x-api-key`, `*token`,
  `password`, …) becomes `<REDACTED>` whatever its shape.
- The MCP bearer the Claude connector hands the CLI travels inside
  `--mcp-config`'s JSON, which the argv carries as one string rather than an
  object, so the key rule cannot see it there; the token-shaped rule catches it
  as `Bearer <token>`, as long as the token is at least twelve characters. A
  real bearer is; the connector's tests use `openade-test-bearer-0000` so their
  recordings show the redaction too.
- The scratch root is taken as the parent of the first stream run's working
  directory, spelled with and without macOS's `/private`. A recorder whose
  first stream run is a probe's handshake in the temp directory names its
  scratch root itself.
- The operator's own skills, commands and agents — every entry of the
  harness's config directory's `skills/`, `commands/` and `agents/`
  (`<home>/.claude` unless `configDir` says otherwise) — are listed by name in
  the CLI's handshake and `system/init`. Each becomes `user-skill-<n>`: as a
  list item, and as an object's `name`, whose `description` goes with it.

### When to re-record

Any CLI release that changes the frames. Three tests fail when it happens, and
they are the notice:

- `packages/connector-cmd/src/recordedFrames.test.ts` — replaying every
  recording must produce no `event.unmapped`. A new frame type fails here
  rather than arriving as an unreadable blob in the timeline. It also pins the
  facts a recording is cited for, such as `hookCount: 0` on all four plan
  recordings and `touchedFiles: []` on the two plan-guard ones.
- `packages/connector-cmd/src/recordedArgs.test.ts` — reads every manifest's
  `connectorArgs` back into a `buildArgs` input, rebuilds it, and demands the
  same list. The two allowed differences are written down in that file.
- the live end-to-end and conformance suites, which run the same assertions
  against the CLI you actually have.

Do not edit a recording. Re-record the scenario, or point the test at a
different one.

## Building and packaging

```sh
pnpm build
```

is `turbo run build --filter='!desktop'` followed by `turbo run build -F
desktop`. What lands where:

| Artifact                             | Produced by                      |
| ------------------------------------ | -------------------------------- |
| `apps/web/dist/`                     | `vite build`                     |
| `apps/server/out/main.cjs`           | esbuild, cjs, node22             |
| `apps/desktop/out/main/index.cjs`    | `apps/desktop/scripts/build.mjs` |
| `apps/desktop/out/preload/index.cjs` | the same                         |
| `apps/desktop/out/server/main.cjs`   | the server, bundled into the app |
| `apps/desktop/out/renderer/`         | a copy of `apps/web/dist`        |
| `apps/desktop/artifacts/<channel>/`  | electron-builder                 |

`pnpm build`'s desktop step runs `node scripts/package.mjs --dir`, which stops
at the unpacked directory. For real installers:

```sh
pnpm build:desktop          # channel stable
pnpm build:desktop:canary   # channel canary
```

macOS targets are `dmg` and `zip` for `arm64` and `x64`; Windows is `nsis`,
Linux is `AppImage` and `deb` (`apps/desktop/electron-builder.config.cjs`). The
channel reaches two places at once: electron-builder switches the app id
(`dev.openade.OpenAde.desktop[.canary]`), the product name and the output
directory, and `scripts/build.mjs` defines `process.env.OPENADE_CHANNEL` into
the bundle so `src/platform/channel.ts` names the running app the same way. A
test asserts the two agree; otherwise the two channels would share userData.

The server is bundled into the app and spawned as a child under
`ELECTRON_RUN_AS_NODE`, so `out/server` is listed in `asarUnpack` — a child
process cannot spawn from inside the asar archive.

Both server bundles define `import.meta.url` — a banner derives it from
`__filename` — because CommonJS has none, and the Claude Agent SDK calls
`createRequire(import.meta.url)` when its module loads: without it the bundled
server throws before it starts. The banner restates `"use strict"` first, so
the bundle stays in strict mode. The preload does not get it; it runs
sandboxed, where `require("node:url")` does not exist.

`apps/desktop` lists `@OpenAde/contracts` and `@OpenAde/shared` as
_devDependencies_ on purpose: esbuild inlines them into the bundle, and
electron-builder packs only `dependencies`, so declaring them as runtime
dependencies would ship a second copy of each.

The config names no code-signing identity, so a machine without a Developer ID
certificate produces an unsigned build. It runs locally; it is not something to
hand to anyone else.

## Where state lives on disk

Everything OpenAde owns hangs off `configDir()` — `~/.openade`, or
`OPENADE_HOME` (`packages/shared/src/paths.ts`).

```
~/.openade/
├── state.sqlite            event log, projections, settings, permissions
├── desktop.json            shell preferences read before Electron is ready
├── attachments/            staged uploads
├── bin/
│   ├── cmd-hook.mjs        generated PreToolUse hook script
│   └── tickets/<id>.ticket per-session bearer, mode 0600
└── dev/connection.json     dev handshake, mode 0600 (dev mode only)
```

`state.sqlite` is migrated on boot by `apps/server/src/persistence/Migrations.ts`;
migration ids are contiguous from 1 and a merged migration file is never
edited — new ones append.

`desktop.json` is the shell's own small file, read synchronously at startup
because it decides Chromium command-line flags. Today it holds one key:
`{ "browserPane": true }` turns on the in-app `<webview>` browser pane, which
makes Chromium open a loopback remote-debugging port. Off by default, and the
server then drives its own Chromium through `agent-browser` instead.
`OPENADE_BROWSER_PANE=1` and `OPENADE_CDP_PORT=<port>` turn it on for one run;
`OPENADE_REMOTE_DEBUG=0` vetoes it. Anything running as this user can drive the
renderer through that port, which is why it is opt-in.

The hook script is regenerated only when its content hash changes, so starting
a session does not churn the file under a running `cmd`.

### The user's Command Code files

`OPENADE_HOME` does not move these: they are the harness's, not ours.

| File                                                  | What OpenAde does to it                              |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `~/.commandcode/mcp.json`                             | user-scope MCP servers, from the settings page       |
| `<workspaceRoot>/.mcp.json`                           | project-scope MCP servers, the same                  |
| `<workspaceRoot>/.commandcode/settings.local.json`    | the PreToolUse hook block, while a session runs      |
| `~/.commandcode/skills`, `<root>/.commandcode/skills` | read only, for the skills list                       |
| `~/.commandcode/projects/<slug>/`                     | the CLI's own transcripts, which the connector reads |
| `~/.commandcode/plans/`                               | where a plan turn's markdown lands                   |

Both written files are edited per entry, not per file. Every MCP server OpenAde
writes carries an `_openade` marker and add/remove refuse to touch an entry
that lacks one; a file that exists but does not parse is never rewritten
(`packages/connector-cmd/src/mcpServers.ts`, the connector's MCP servers
extension). The hook block is installed on
session start and reverted on close, but only while the file still hashes to
the bytes the install wrote, and only once the last session in that project has
gone (`packages/connector-cmd/src/config.ts`).

The `boot()` option `commandCodeHome`, handed to
`makeCmdConnectorDefinition`, redirects the files the Customize page edits,
which is how tests avoid editing the real ones.

## Repository conventions

- **One commit per logical change**, conventional subject:
  `type(scope): what changed`, lowercase, in the imperative — `fix(connector):
spawn the binary the probe resolved`, `feat(web): rename, archive and delete
a thread`. Scopes name the area, not the workspace path.
- **No attribution trailers.** No `Co-Authored-By`, no "generated with" line,
  in commit messages or pull request descriptions.
- **Documentation lives in `docs/`**, five documents indexed by
  [docs/README.md](README.md). They are markdown that oxfmt formats like any
  other file, so `pnpm fmt` rewraps them and `pnpm fmt:check` fails on a
  document that was not rewrapped. Describe the software, not the history of
  building it.
- **Never `--no-verify`.** `pnpm check` is the gate; if it is red the change is
  not finished.

## Troubleshooting

**The window sits on "starting", or the shell reports the server failed.** The
supervisor gives the child 15 s to produce its fd 3 handshake, restarts it with
500 ms → 10 s backoff, and after five consecutive failures stops and reports
instead of spinning. The server's stdout and stderr are inherited, so the real
error is in the terminal running `pnpm dev`. Check that nothing else already
holds the same `OPENADE_HOME` — two servers over one `state.sqlite` is the
usual cause after a force quit. On a normal quit the supervisor signals SIGINT
and waits for the child to exit, SIGKILLing it after 5 s.

**A browser renderer dials a dead server.** `~/.openade/dev/connection.json` is
written on every dev boot and is not deleted on shutdown, so a stale one points
at a port nobody is listening on. Delete it and restart `pnpm -F server dev`.
If you are running a scratch home, remember the Vite plugin resolves the file
through the same `OPENADE_HOME` — start both sides with the same value or they
will never meet.

**`cmd` not found, or found by the probe and not by the turn.** Both the probe
and the spawn go through `resolveBinary`, so they agree; what differs is the
environment. A packaged `.app` launched from Finder inherits launchd's `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), which is why the resolver also searches the
global bin directories. If your install is somewhere else, set `binaryPath` on
the connector instance in Settings. The npx fallback works but downloads
`command-code@latest` on first use.

**Insufficient credits.** Exit code 10, reported as
`insufficient credits — top up at https://commandcode.ai/billing and retry`.
The full exit-code table is `packages/connector-cmd/src/exitCodes.ts`: 3 is not
logged in, 4 is the CLI's own permission refusal, 5/6/7 are retryable transport
failures, 8 is `--max-turns`, 130 is an interrupt.

**`pnpm knip` fails on a fresh tree** with an unresolved
`apps/web/src/routeTree.gen.ts`. That file is generated by `vite build` and
gitignored; run `pnpm typecheck` or `pnpm build` first. knip is a root script
and not a turbo task, so it does not build anything itself.

**A check passes locally and fails in CI, or the other way round.** Turbo
caches `build`, `test` and `check-types` in `.turbo`. Force a stage to rerun
with `pnpm exec turbo run check-types --force`. Note that `test` declares
`"inputs": ["$TURBO_DEFAULT$", "!README.md"]`, so editing a README does not
invalidate a test cache.

**An end-to-end test hangs instead of failing.** It should not: everything is
awaited through a receipt or a subscription. A hang means something is waiting
on an item that will never arrive — read the harness's `awaitItem` call rather
than raising a timeout. The replay driver already allows 120 s per test and the
live driver 600 s.
