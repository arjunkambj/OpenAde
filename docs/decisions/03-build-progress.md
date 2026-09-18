# 03 · Build progress and how to resume (updated 2026-09-18)

This file is the hand-off between build sessions. Update the status table and the
"next session starts here" section every time a workstream lands on `main`.

## Status

| Workstream                                       | Branch                  | Status           | Landed on main |
| ------------------------------------------------ | ----------------------- | ---------------- | -------------- |
| Plan review                                      | `feat/w0-foundation`    | done             | 2026-09-15     |
| W0 Foundation, contracts, connector SDK, testkit | `feat/w0-foundation`    | **done, merged** | 2026-09-15     |
| W1 Persistence and orchestration engine          | `feat/w1-orchestration` | **done, merged** | 2026-09-18     |
| W2 Command Code connector                        | `feat/w2-connector-cmd` | **done, merged** | 2026-09-18     |
| W3 Transport and client runtime                  | `feat/w3-transport`     | **done, merged** | 2026-09-18     |
| W7 Desktop shell and packaging                   | `feat/w7-desktop`       | **done, merged** | 2026-09-18     |
| W8 Git, checkpoints, files                       | `feat/w8-git`           | **done, merged** | 2026-09-18     |
| W4 Renderer shell and timeline                   | `feat/w4-renderer`      | **done, merged** | 2026-09-18     |
| W5 Composer and interaction cards                | `feat/w5-composer`      | **done, merged** | 2026-09-18     |
| W6 Browser, MCP server, preview pane             | `feat/w6-browser`       | **done, merged** | 2026-09-18     |
| W9 Settings, connectors, MCP and skills editor   | `feat/w9-settings`      | **done, merged** | 2026-09-18     |
| W10 Integration                                  | `feat/w10-integration`  | **done, merged** | 2026-09-18     |

Milestone M0 (workspace builds, gate green, contracts and fakes published) is
reached. So is M1: every wave-1 and wave-2 workstream is integrated on one
branch, `pnpm check` is green across 10 packages and 143 tests, `pnpm build`
produces the server bundle, the web assets and a launchable `OpenAde.app`, and
the built server boots, migrates and answers on its loopback routes.

The landing site (`feat/w11-launch`, `apps/site`) is deliberately out of this
integration and still sits on its own branch.

## What W0 landed

45 feature commits on top of the plan docs; `pnpm check` is green (lint, oxfmt,
typecheck on 10 packages, 140 tests, boundaries, file sizes, knip) and CI runs
the same gate on Linux and macOS (`.github/workflows/ci.yml`).

- Root: `pnpm-workspace.yaml` catalog pins Effect 4.0.0-rc.112 (effect,
  @effect/platform-node, @effect/atom-react, @effect/vitest), vitest 4.1.11, tsx,
  esbuild, @legendapp/list, @pierre/diffs, react-markdown, remark-gfm, knip. The
  lockfile already contains everything wave 1 and wave 2 need (decision D2).
- `scripts/check-boundaries.mjs` (package allowlist, relative-import escape
  detection, renderer connector-neutrality grep, barrel-file refusal) and
  `scripts/check-file-sizes.mjs` (800 lines, 400 for renderer components).
- `packages/shared`: `ids` (dependency-free UUIDv7), `paths` (`~/.openade`,
  `OPENADE_HOME` override, `state.sqlite`, `bin/`, dev connection file).
- `packages/contracts`: `base`, `ids`, `enums`, `runtime` (23 RuntimeEvent
  variants), `orchestration` (Command union, OrchestrationEvent, read models,
  stream items), `settings` (Settings, PermissionRule, CmdConnectorConfig with
  settingsForm annotations, default keybindings), `rpc` (the RpcGroup, every RPC
  from spec section 6, `OpenAdeRpcError`, stream budget constants). 109 JSON
  fixtures under `packages/contracts/fixtures/` round-trip in tests; a variant
  without a fixture fails the suite.
- `packages/connector-sdk`: `definition` (ConnectorDefinition, ConnectorInstance,
  ConnectorServices, TurnInput, tagged ConnectorError variants, erased
  definitions), `sessionHandle` (SessionHandle + bounded queue with the 64-slot
  terminal reserve), `turnScopedHandle` (`makeTurnScopedHandle`), `conformance`
  (`runConnectorConformance`), `registry` (`makeRegistry`, routes by instance id),
  `streamCollector`.
- `packages/testkit`: `fakeConnector` (a scripted connector; passes the
  conformance suite), `receipts`, `sqlite` (node:sqlite in-memory helper),
  `replayCmdProcess` + `bin/replay-cmd.mjs` (replays the real recordings under
  `fixtures/cmd/`: frames, transcript growth, hook calls, exit codes).
- Stubs with declared dependencies and a placeholder `meta` module:
  `packages/client-runtime`, `packages/connector-cmd`, `apps/server` (`tsx watch`
  dev script, esbuild bundle to `out/main.cjs`).
- Docs: `00-plan-adaptation.md` (repo facts), `01-plan-review.md` (decisions
  D1–D10), `02-w0-contract-notes.md` (the five places the code departs from the
  spec sketch, additive shapes, who owns the two missing guardrail tests).

## Things every later workstream must know (from W0's implementers)

1. RuntimeEvent variants nest their data under `payload` (02 · N1). Commands keep
   their fields flat.
2. `TurnScopedSessionHandle.interrupt(turnId)` is turn-scoped and does not return
   until the turn settles; it needs the wrapper's `events` stream to be consumed.
   `awaitTurn(turnId)` waits without interrupting. `send(turnId, turn)` is the
   server-facing send. A fatal `runtime.error` settles the turn with a synthesized
   `turn.completed { stopReason: "error" }`; a stream that dies adds a fatal
   `runtime.error` before that completion. `send` fails with `SessionClosed` once
   the stream has ended.
3. The server's TurnId overwrites `payload.turnId` on turn.started,
   turn.completed, turn.plan.proposed and usage.updated; a translator may pass
   whatever the harness gave it.
4. Terminal events for the queue reserve are `turn.completed`, `session.ended`,
   `runtime.error` (`TERMINAL_EVENT_TYPES`); dropped non-terminal events are
   counted in `BoundedEventQueue.dropped` and should surface as `session.warning`.
5. `ConnectorDefinition<Config>` is invariant; use `eraseConnectorDefinition` and
   `makeRegistry([eraseConnectorDefinition(cmdConnector)])`. The SDK
   `ConnectorProbe` is a superset of the wire one; `toWireProbe` narrows it.
6. FakeConnector emits `turn.started`/`turn.completed` itself and withholds the
   completion until every request it opened is resolved; scripts contain only the
   body of a turn.
7. Stub `meta.ts` + `meta.test.ts` + the `./meta` export entry are deleted by the
   workstream that gives the package real modules.
8. knip runs in the gate and looks inside package entry files. Escape hatches
   (02 · N3): a `@public` JSDoc tag naming the consuming workstream, or a per-file
   `ignoreIssues`. When you start importing a pre-declared dependency, delete its
   line from `knip.json` in the same commit.
9. Boundaries are deny-by-default: add an allowlist rule in
   `scripts/check-boundaries.mjs` before adding a workspace. `apps/server` may use
   `@OpenAde/testkit` only from `*.test.*` files (`TEST_ONLY_ALLOWLIST`).
10. Lint enforces: no `@ts-ignore`; `@ts-expect-error: <reason> https://…`; no
    `as any` outside tests and generated files; no timers or sleeps in test files.
11. `pnpm-workspace.yaml` sets `allowBuilds: msgpackr-extract: false` (JS fallback
    for Effect RPC); W3 may flip it if the transfer-budget test shows it matters.
12. `packages/shared` has no Effect dependency on purpose; the renderer may import
    `@OpenAde/shared/ids` but not `/paths`.
13. `apps/desktop` lists contracts and shared as devDependencies (esbuild bundles
    them; electron-builder packs only `dependencies`).
14. W3 landed decision D3: `apps/web` no longer reads `VITE_SERVER_URL`; the dev
    server writes the dev connection file and the web Vite plugin serves it at
    `/__openade/connection`. Both sides resolve that path through
    `devConnectionPath()` in `@OpenAde/shared/paths`, so `OPENADE_HOME` moves it.
15. Two guardrail tests are assigned, not written: transfer budget → W3, migration
    lineage → W1 (02 · last section).
16. The browser pane (W6 mode A) is opt-in, because it makes Chromium open a
    loopback remote-debugging port. The shell reads `browserPane: boolean` from
    `<config dir>/desktop.json` (`OPENADE_HOME`-aware, default off) before
    `app.whenReady`; `OPENADE_BROWSER_PANE=1` and `OPENADE_CDP_PORT=<port>`
    override it, `OPENADE_REMOTE_DEBUG=0` vetoes it. With no port the server's
    `OPENADE_CDP_PORT` is empty, `cdpAvailable` is false and every thread runs
    mode B (owned Chromium), so anything exercising mode A must turn it on.
17. Permission rules live in the `permission_rules` table, and only there. The
    ladder filters them by scope on every tool call and "allow always" appends a
    row from the approval flow, so a JSON blob would be the wrong shape and a
    second store. The wire `Settings.permissions` array is a projection:
    `SettingsStore.get` reads the table through `readRules`, `settings.update`
    with a `permissions` array replaces it through `writeRules`, and the
    document's own JSON copy is always stored empty so the two can never
    disagree. A settings editor edits the array as usual; nothing else needs to
    know where the rows are.
18. `CmdConnectorConfig.defaultModel` (contracts · settings.ts) is inert: nothing
    reads it. A thread's starting model comes from the global
    `settings.defaults.model`, resolved in `Engine.buildContext` on
    `thread.create`; honouring a per-instance default means resolving it there
    against the thread's connector instance, which is engine work, not connector
    work. Until that lands, the settings page renders an input that does
    nothing — wire it or drop the field and its `settingsForm` annotation
    (`settings.test.ts` requires every field of that struct to carry one).
19. `packages/connector-cmd/src/{session,translate}.ts` sit just under the 800-line
    budget. The next change to either one splits a piece out rather than trims
    comments; `approvals.ts` and `exitCodes.ts` are the pattern.
20. The connector owns two of the user's files (`.commandcode/settings.local.json`,
    `~/.commandcode/projects/<slug>/mcp.json`) and merges into them. Both installs
    return `null` — write nothing — when the file exists but is not strict JSON,
    because merging onto a failed parse silently replaces what the user had. Any
    new file OpenAde writes into a user's project inherits that rule.

## Next session starts here

Waves 1 and 2 are integrated. `feat/w10-integration` was cut from the W7 tip
(which carried the 27-commit shared base) and the other eight branches were
cherry-picked onto it oldest first: W1, W3, W8, W2, then W4, W5, W9, W6. Every
original commit kept its message and author; the integration's own fixes are
separate commits on top. History stays linear and nothing has been pushed to
`origin`.

The nine feature worktrees under `.claude/worktrees/` and their branches are
still on disk. They are fully contained in `main` now — delete them when you no
longer want them for reference:

```bash
cd /Volumes/main/Code/OpenAde
for w in w1 w2 w3 w4 w5 w6 w7 w8 w9 w10; do git worktree remove ".claude/worktrees/$w"; done
git branch -d feat/w1-orchestration feat/w2-connector-cmd feat/w3-transport \
  feat/w4-renderer feat/w5-composer feat/w6-browser feat/w7-desktop \
  feat/w8-git feat/w9-settings feat/w10-integration
```

### Seams the integration reconciled

Read these before changing the code around them — they are decisions, not
mechanical merges.

1. **One renderer atom runtime.** `apps/web/src/state/app-runtime.tsx` (W4) owns
   the single `makeRuntime` instance, the shared registry provider and the
   offline layer that keeps every atom mountable without a server.
   `apps/web/src/lib/app-runtime.ts` (W9) no longer builds its own runtime: it
   adds the settings-only atoms on top of that instance and publishes them
   through `useAppAtoms()`. Atoms the shared client runtime already carries
   (`skillsAtom`, `connectorModelsAtom`, `keybindingsAtom`,
   `keybindingsUpdateAtom`) are not redefined.
2. **Settings routes.** W9's concrete pages (`/settings`, `/settings/connectors`,
   `/settings/mcp`, `/settings/skills`, `/settings/keybindings`,
   `/settings/appearance`) replaced W4's placeholder `/settings/$section`, which
   is gone along with its unimplemented "Uses" section. The sidebar, the search
   palette and the sidebar-footer link all point at the concrete routes.
3. **`/welcome`.** W9's first-run flow (directory picker, connector probe,
   project create) is the page; W4's connection-details card lives on inside it,
   so "which channel resolved the server, and is the socket up" is still one
   glance when the probe cannot reach the server at all.
4. **One ConnectorServices bundle.** `SessionServices` (W6) supplies the
   gateway's per-thread MCP url and bearer, the attachments directory, the
   logger and the clock. The entrypoint overrides only what needs the running
   app: the hook bridge's endpoint and handler registry (W2) and the
   project-aware permission decision (W1).
5. **`POST /hooks/pretooluse` has one owner** — the hook bridge. W6's 501
   placeholder for the same path is gone; two declarations made the router
   refuse to build.
6. **Boot order.** The entrypoint builds one sqlite client and runs the
   migrations itself before any layer is constructed. The service layer — and
   with it the connector manager's first reconcile against `settings.connectors`
   — is built before the engine, whose `runMigrations` used to be the first one
   to touch the schema.
7. **`ServerSupervisor` stays Electron-free.** W6's `OPENADE_CDP_PORT` went into
   `serverDeps.ts`, where W7's injectable spawn spec is built, not into the
   supervisor class.
8. **The dev handshake file** resolves through `@OpenAde/shared/paths`
   (`devConnectionPath()`) in both the server bootstrap and the web Vite plugin,
   so `OPENADE_HOME` moves it for both.

### Known gaps

- No automated test boots the real entrypoint. The migration-order and
  duplicate-route bugs above were both found by hand, by running the built
  bundle; the suites passed throughout. A boot smoke test is the obvious next
  guardrail.
- `apps/server/src/browser/live.test.ts` is skipped by default (it wants a real
  browser), as is the live `cmd` smoke behind `OPENADE_LIVE_CMD=1`.
- Nothing has been run against a real Command Code install in this session.

### Wave 1 briefs

Shared preamble for every brief: read `00`, `01`, `02` and this file, then the
spec sections named below; contracts are the seam (a new field or RPC goes into
`packages/contracts` first, additive, with a fixture and round-trip test, in its
own commit); never touch `pnpm-lock.yaml` or the catalog without a decision doc;
owned directories are exclusive; commit feature by feature with plain messages
and no attribution trailers; `pnpm check` green in the worktree before review.

**W1 orchestration** (`apps/server/src/{persistence,orchestration,permissions}`;
spec section 9 and W1): Sqlite Effect service over `node:sqlite` (reference
`zuse/packages/sqlite/src/index.ts`), numbered migrations imported statically
plus the lineage test; EventStore with optimistic concurrency on
`(stream_kind, stream_id, stream_version)`; pure `decider.ts` with a table test
per Command; `projector.ts`; `Engine.ts` (dispatch = load, decide, append,
project, receipt, publish in one transaction; idempotent on commandId; 50ms
coalescing; per-subscription budget from `@OpenAde/contracts/rpc` failing with
`resnapshot-required`); reactors ProviderCommandReactor, RuntimeIngestion,
SessionSupervisor (boot resume, backoff, `thread.session.lost`), CheckpointReactor
hook point behind an interface W8 implements; PatternMatcher with Command Code's
syntax and PermissionService.decide with the sensitive-path list, 100-row table
test. Done when a scripted FakeConnector conversation (turn, tool, approval, plan,
interrupt, crash-resume) yields byte-identical projections across two runs, a
mid-turn kill resumes from the persisted sessionRef, and the budget test fails the
stream and a resubscribe recovers.

**W2 connector-cmd** (`packages/connector-cmd`, `apps/server/src/hooks`,
`packages/testkit/{fixtures/cmd,src/replayCmdProcess.ts}`; spec sections 5 and 8).
Day one is done and the plan is paid for: the real CLI has been recorded across
sixteen scenarios under `packages/testkit/fixtures/cmd/`, every §5.7 unknown is
answered in `docs/decisions/w2-cmd-frames.md`, and there is no stand-in binary
any more. Then: probe (binary discovery incl. the `@latest` npx fallback,
`status --json`, a warning only below `OLDEST_TESTED_VERSION`), `spawn.ts` (argv, env allowlist, detached
group, SIGINT then SIGKILL after 5s, descendant check), `ndjson.ts`,
`transcript.ts` (byte-offset tailer), `translate.ts` (frames + transcript →
RuntimeEvent with `payload` nesting, dedupe on tool_use.id and messageId, tool
vocabulary from 5.4), `hookScript.ts` (`~/.openade/bin/cmd-hook.mjs`, mode 0700,
hash-checked per spawn), `config.ts` (settings.local.json hook block and
projects/<slug>/mcp.json entry with ownership markers), session ref shape, runtime
mode → flags, plan mode via plans-index.json, per-turn model/effort,
`--list-models` → ModelOption[], exit-code mapping (3, 10, 130);
`apps/server/src/hooks/HookBridge.ts` (loopback POST /pretooluse, per-session
bearer, 590s ceiling, 1MB cap, journaling interface, ask_user_question path).
`replay-cmd.mjs` replays a recording progressively and calls the installed hook
at the recorded points. Done when `runConnectorConformance(cmdConnector, …)`
passes against a recording *and* against the real CLI behind
`OPENADE_LIVE_CMD=1` (`apps/server/src/hooks/cmdLiveConformance.test.ts`).

**W3 transport** (`apps/server/src/rpc`, `packages/client-runtime`, the D3 Vite
plugin in `apps/web/vite.config.ts`, removal of `apps/web/.env`; spec section 10
and decision D3): RpcServer over WebSocket (`effect/unstable/rpc`,
`RpcServer.makeProtocolWithHttpEffectWebsocket` on GET /ws,
`RpcSerialization.layerJson`; token on the upgrade query, wrong token → 401;
reference `t3code/apps/server/src/ws.ts` 3427–3466), `server.hello` with
protocolVersion and serverInstanceId, every RPC wired to Tag-based service
interfaces with in-memory fakes so the server runs before W1 lands; bootstrap
that emits `{ port, token, serverInstanceId }` on fd 3, or one stdout line and
`~/.openade/dev/connection.json` in dev. Client: `makeConnection({ url, token })`
Layer with RpcClient, reconnecting protocol with backoff, connection state;
resume with afterSequence, `resnapshot-required` handling, serverInstanceId change
→ full resnapshot; AtomRuntime and atom factories (threadDetailAtom,
threadListAtom, projectsAtom, connectorsAtom, settingsAtom, connectionStateAtom,
dispatchAtom awaiting receipts); connection resolver order preload →
`/__openade/connection` → search params. Owns the transfer-budget test
(bytes-on-the-wire for a 200-item thread). Done when a headless client drops the
socket, reconnects and receives exactly the missed events; atoms update only for
their thread; wrong token → 401.

**W7 desktop** (`apps/desktop`, root `dev` script, `.claude/launch.json`; spec
section 13): split `src/main/index.ts` into window, protocol and `platform/`
modules; `src/backend/ServerSupervisor.ts` (spawn the server bundle, or tsx in
dev, with `ELECTRON_RUN_AS_NODE=1` and a fourth pipe for the handshake; backoff
500ms → 10s; pause with a dialog after 5 failures; reference
`t3code/apps/desktop/src/backend/DesktopBackendManager.ts`); preload exposing only
`getConnection()`, `onServerState(cb)`, `openExternal(url)`, `pickDirectory()`
and a stub browser-pane bridge; remote-debugging port on loopback behind a flag;
`webviewTag` for `persist:thread-*` partitions with a will-attach-webview guard;
window state persistence; dev loop running Vite, the server in watch mode and
Electron together; electron-builder config including the server bundle; updater
stub behind a flag; launch.json entries `dev`, `dev:web` (3001), `dev:server`.
Done when `pnpm dev` opens the app connected to a live (fake-backed) server,
killing the server reconnects within 3s with a banner state via onServerState,
and `pnpm build:desktop` produces a dmg and zip that launch.

**W8 git** (`apps/server/src/git`, the files and git RPC handlers behind the Tags
W3 defines; spec W8): GitService via argv-form execFile (status; diff of
worktree, HEAD, checkpoint to checkpoint), CheckpointStore (hidden refs
`refs/openade/checkpoints/<threadId>/<turnId>` from a temporary index; list,
restore with a confirmation flag, prune on thread delete), DiffService producing
unified diffs @pierre/diffs can render, `files.search` ignore-aware walker with a
warm cache (50k files under 200ms) and `files.read` with a size cap. Tests use
temporary repositories created with `git init`. Done when two turns give two
checkpoints with the correct diff between them and restore reverts the worktree.
