# 01 · Plan review before build (2026-09-15)

Reviewed `docs/specs/mvp-build-spec.md` v0.2 and `00-plan-adaptation.md` against this repository, the reference repos, npm and this machine. The plan holds: architecture, contracts, workstream split and guardrails stand unchanged. The items below are gaps that would have blocked or slowed parallel agents; each is now a decision every workstream follows.

## Verified since v0.2

- `cmd` runs through `npx -y command-code@1.54.0`; `cmd status --json` reports authenticated (user arjunkambj, provider command-code, default model stealth/ox-alpha). Credits are still unknown; W2 finds out with one minimal live turn on day one.
- `node:sqlite` works under Electron 44.3.0 (`ELECTRON_RUN_AS_NODE=1`, Node 24.20.0): `DatabaseSync` constructs and executes DDL. No native-module fallback is needed.
- `@effect/vitest@4.0.0-rc.112` peer-depends on `vitest >=4.1.0 <5`; vitest 4.1.11 satisfies it. t3code's `@effect/vitest` patch only redirects to vite-plus and is not used. t3code's `effect` patch (an MCP session DELETE route and RpcClient request hooks) is not applied either; if W6 needs session cleanup it adds its own route.
- Effect stays at 4.0.0-rc.112 although rc.115 exists: all reference code is on .112. A bump moves all four packages together and is its own commit.
- 182 real Command Code transcripts exist under `~/.commandcode/projects`; they are read for shapes only, never copied.
- Every reference file the spec cites exists. Two citations are thin: `t3code/packages/client-runtime/src/rpc/protocol.ts` and `t3code/apps/web/src/state/orchestration.ts` are re-export shims; follow their imports.

## Decisions

### D1 Internal packages are consumed as TypeScript source

- Every package under `packages/` exposes source through `package.json` `exports` with one entry per module (`"./ids": "./src/ids.ts"`), the way `packages/ui` already does. No build step, no `dist`, no barrel `index.ts`.
- Consumers use `moduleResolution: bundler` (already in `packages/config/tsconfig.base.json`). Vite, esbuild, tsx and vitest resolve source exports directly.
- Apps are unscoped (`web`, `desktop` and the new `server`) to match the existing turbo filters; packages are `@OpenAde/*`.
- `apps/server` runs with `tsx watch src/main.ts` in dev and is bundled by esbuild to `apps/server/out/main.cjs` for packaging; `apps/desktop/scripts/build.mjs` copies that bundle next to the renderer.

### D2 W0 declares every dependency up front

W0 adds every third-party dependency later workstreams need to the catalog and to the stub package.jsons, then commits the lockfile once. Later branches do not touch `pnpm-lock.yaml` unless a decision doc says why. The list: `effect`, `@effect/platform-node`, `@effect/atom-react`, `@effect/vitest` (all rc.112); `vitest` 4.1.11; `tsx`; `esbuild`; `@legendapp/list` 3.3.x; `@pierre/diffs` 1.4.x; `react-markdown` 10; `remark-gfm` 4; `knip` 6. Server-side HTTP, WebSocket, RPC and MCP come from `effect/unstable/*` and `@effect/platform-node`; no `ws`, no MCP SDK.

### D3 A browser-only renderer can connect in dev

- `apps/server` in dev mode (`--dev` flag or `OPENADE_DEV=1`) writes `~/.openade/dev/connection.json` = `{ url, token, serverInstanceId }` in addition to the fd-3 handshake. When fd 3 is not open (started from a terminal) it prints the same JSON as one line on stdout instead of failing.
- `apps/web/vite.config.ts` gets a dev-only plugin serving that file at `GET /__openade/connection`.
- `packages/client-runtime` resolves the connection in this order: `window.openade.getConnection()` (Electron preload) → `fetch("/__openade/connection")` (Vite dev) → `?server=<url>&token=<t>` search params. This lets the renderer be verified in a plain browser and lets `pnpm dev:web` plus `pnpm dev:server` work without Electron.

### D4 Precise guardrail patterns

The apps/web grep test uses `/\bcommandcode\b/i`, `/"cmd"/` (the quoted literal only, so keybinding labels like `Cmd+K` pass) and `/\bclaude\b/i` over `apps/web/src`, excluding `components/ui/icons`.

### D5 CI and the local gate

- `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` and `pnpm check` on ubuntu-latest and macos-latest. W0 adds it.
- `pnpm check` = lint, format check, typecheck, test, boundary check, file-size check. It is the merge gate for every branch; a branch is not reviewed until it passes in its own worktree.

### D6 Renderer routes

- Keep the `_home` layout. W4 adds `_home/t.$threadId.tsx`, `welcome.tsx`, and dev-only `dev/timeline.tsx` and `dev/composer.tsx` (mounted only when `import.meta.env.DEV`).
- Settings sections are file routes under `settings/`: `index` (General), `connectors`, `mcp`, `skills`, `keybindings`, `appearance`. The existing `settings/uses.tsx` is folded into General or removed by W9.

### D7 Workstream W10, integration, is added

The spec has no owner for wiring the pieces together. W10 owns `apps/server/src/main.ts` (Layer composition), the desktop supervisor ↔ server handshake end to end, renderer atoms ↔ live server, the "hello turn" smoke on fakes, and the release checklist. It runs after wave 2.

### D8 Waves, branches, worktrees

- Wave 0: W0 on `feat/w0-foundation` (worktree `.claude/worktrees/w0`).
- Wave 1 (parallel, from main after W0): W1 `feat/w1-orchestration`, W2 `feat/w2-connector-cmd`, W3 `feat/w3-transport`, W7 `feat/w7-desktop`, W8 `feat/w8-git`.
- Wave 2 (parallel, from main after wave 1): W4 `feat/w4-renderer`, W5 `feat/w5-composer`, W6 `feat/w6-browser`, W9 `feat/w9-settings`.
- Wave 3: W10 `feat/w10-integration`.
- Every worktree lives under `.claude/worktrees/<name>` (gitignored). Each workstream commits feature by feature with plain messages and no attribution trailers. Branches are rebased onto main and fast-forwarded after review, so main stays linear and each feature commit survives.
- Root files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `pnpm-lock.yaml`, `.oxlintrc.json`) are W0's; later workstreams touch them only for their own package's turbo filter or a documented dependency.

### D9 Repository hygiene

- `.gitignore`: `docs/*` stays ignored for private planning material, with `!docs/decisions/` and `!docs/specs/` re-included so the spec and decisions are tracked. `.claude/worktrees/` is ignored.
- `apps/web/.env` (`VITE_SERVER_URL=http://localhost:3000`) is a template leftover and is removed by W3 when D3 lands. `.claude/launch.json` gains `dev:web` (port 3001) and `dev:server` entries in W7.

### D10 Existing renderer code

`apps/web/src/components/Chat/*` keeps its visual language (message bubbles, activity disclosure, changed-files card). W4 moves the timeline into `components/timeline/` row components fed by atoms and deletes `seed-thread.tsx`; `composer.tsx` becomes W5's starting point with its placeholder model and permission lists replaced by atoms. Nothing in `packages/ui` is restyled from `apps/web`.

## Not changed

Contracts (section 6), connector SDK (7), connector design (8), server design (9), transport (10), browser plan (12), desktop shell (13), milestones and guardrails stand as written. Field names remain final.
