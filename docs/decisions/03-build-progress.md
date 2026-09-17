# 03 · Build progress and how to resume (updated 2026-09-15)

This file is the hand-off between build sessions. Update the status table and the
"next session starts here" section every time a workstream lands on `main`.

## Status

| Workstream                                       | Branch                  | Status               | Landed on main |
| ------------------------------------------------ | ----------------------- | -------------------- | -------------- |
| Plan review                                      | `feat/w0-foundation`    | done                 | 2026-09-15     |
| W0 Foundation, contracts, connector SDK, testkit | `feat/w0-foundation`    | **done, merged**     | 2026-09-15     |
| W1 Persistence and orchestration engine          | `feat/w1-orchestration` | ready for review     | –              |
| W2 Command Code connector                        | `feat/w2-connector-cmd` | not started          | –              |
| W3 Transport and client runtime                  | `feat/w3-transport`     | not started          | –              |
| W7 Desktop shell and packaging                   | `feat/w7-desktop`       | not started          | –              |
| W8 Git, checkpoints, files                       | `feat/w8-git`           | not started          | –              |
| W4 Renderer shell and timeline                   | `feat/w4-renderer`      | not started (wave 2) | –              |
| W5 Composer and interaction cards                | `feat/w5-composer`      | not started (wave 2) | –              |
| W6 Browser, MCP server, preview pane             | `feat/w6-browser`       | not started (wave 2) | –              |
| W9 Settings, connectors, MCP and skills editor   | `feat/w9-settings`      | not started (wave 2) | –              |
| W10 Integration                                  | `feat/w10-integration`  | not started (wave 3) | –              |

Milestone M0 (workspace builds, gate green, contracts and fakes published) is reached.

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
- `packages/testkit`: `fakeConnector` (passes the conformance suite), `receipts`,
  `sqlite` (node:sqlite in-memory helper), `fakeCmdProcess` (NDJSON + transcript
  - hook replay; fixture `fixtures/cmd/run-error.ndjson`).
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
14. `apps/web/.env` still holds the template's `VITE_SERVER_URL`; W3 removes it when
    decision D3 (dev connection file + Vite plugin) lands. `.claude/launch.json`
    still points `dev` at port 3000; W7 fixes it (D9).
15. Two guardrail tests are assigned, not written: transfer budget → W3, migration
    lineage → W1 (02 · last section).

## Next session starts here

Wave 1 runs W1, W2, W3, W7 and W8 in parallel, each in its own worktree and
branch, each committing feature by feature, each reviewed before merge
(01 · D8). Suggested mechanics:

```bash
cd /Volumes/main/Code/OpenAde
for w in w1-orchestration w2-connector-cmd w3-transport w7-desktop w8-git; do
  git worktree add ".claude/worktrees/${w%%-*}" -b "feat/$w" main
done
```

Then `pnpm install` inside each worktree. When a branch passes `pnpm check` and
review, rebase it onto `main` and fast-forward merge; run `pnpm install
--frozen-lockfile && pnpm check` on `main` afterwards. Delete the worktree and
update the table above.

The W0 worktree and the `feat/w0-foundation` branch were removed after the merge;
main carries every W0 commit. Nothing has been pushed to `origin` yet.

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
`packages/testkit/{fixtures/cmd,src/fakeCmdProcess.ts}`; spec sections 5 and 8):
day one run `npx -y command-code@1.54.0 status --json`, `--list-models`, `--help`,
then one minimal live turn in a scratch directory (`-p "Reply with exactly: ok"
--output-format json --verbose -t --skip-onboarding --no-auto-update --max-turns 1
--no-session`) to learn whether credits exist; record real frames and transcript
to `packages/testkit/fixtures/cmd/` if it works and answer spec 5.7 in
`docs/decisions/w2-cmd-frames.md`, otherwise say so there and build on the
section 5 frames. Then: probe (binary discovery incl. the npx fallback, `status
--json`, version warning below 1.54), `spawn.ts` (argv, env allowlist, detached
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
Fill FakeCmdProcess to replay fixtures progressively and serve hook POSTs. Done
when `runConnectorConformance(cmdConnector, …)` passes with FakeCmdProcess; live
smoke behind `OPENADE_LIVE_CMD=1`.

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
