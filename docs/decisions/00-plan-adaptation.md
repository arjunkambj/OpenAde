# 00 · Plan adaptation for this repository

Applies to `docs/specs/mvp-build-spec.md` (v0.2, 2026-09-15). Every workstream reads this, then `01-plan-review.md`, before the spec.

## Root and layout

- The spec names `/Volumes/main/Code/ade/openade/` as the root. That path does not exist. The root is **this repository** (`OpenAde`).
- Existing packages stay and are extended, never rebuilt: `apps/web` (React 19, TanStack Router, Tailwind 4), `apps/desktop` (Electron 44, esbuild scripts), `packages/ui` (shadcn/base-ui design system), `packages/config` (tsconfig base).
- New packages follow the spec's section 4 exactly: `apps/server`, `packages/{contracts,connector-sdk,connector-cmd,client-runtime,shared,testkit}`.
- Apps are unscoped (`web`, `desktop`, `server`). Packages are `@OpenAde/*` (matches `packages/ui`) and export TypeScript source, no build step (01 · D1). Config dir is `~/.openade`. The renderer scheme is `openade://app/` (spec sections 13 and 17); the scaffold's generic `app://openade/` was replaced when the browser pane made the renderer's origin load-bearing.
- The spec's `docs/decisions/` lives at `docs/decisions/` in this repo and is tracked; the rest of `docs/` is private and ignored.

## Renderer

- The spec's W4 "app shell, sidebar, theme, base-ui primitives" already exists under `apps/web/src/components/{Layout,Chat,Settings}` and `packages/ui`. W4 and W5 wire those to atoms and add what is missing (`timeline/` rows, `composer/` cards, `panes/`). Existing component files keep their paths.
- Renderer state is `@effect/atom-react` only. The existing `React.useState` seed data in `Chat/` is replaced by atoms from `packages/client-runtime`.
- The oxlint config with `@shadcn/lint` rules is authoritative for styling: no raw colours, no arbitrary values, no restyling of design-system components outside `packages/ui`.

## Versions

| Layer      | Spec                    | This repo                                                                                                    |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| pnpm       | 10                      | 11.21 (catalog + `allowBuilds` already in use)                                                               |
| Node       | 22.16+                  | 25.9 on this machine; `engines` says `>=22.16`; Electron 44 bundles Node 24.20 with `node:sqlite` (verified) |
| Vite       | 7                       | 8                                                                                                            |
| TypeScript | –                       | 6 via catalog                                                                                                |
| Electron   | 44                      | 44.3                                                                                                         |
| Effect     | 4.0.0-rc.112            | 4.0.0-rc.112, pinned together with `@effect/atom-react`, `@effect/platform-node`, `@effect/vitest`           |
| Tests      | vitest + @effect/vitest | vitest 4.1.11 + `@effect/vitest` rc.112 (peer range `>=4.1 <5`; t3code's vite-plus patch is not used)        |

## External binaries on this machine (2026-09-15)

- `cmd` (command-code 1.54.0) is **not on PATH** but runs through `npx -y command-code@1.54.0`, and `cmd status --json` reports authenticated. The connector probe searches config path, PATH, npm/pnpm/bun global bins and falls back to `npx -y command-code@1.54.0`. Credits are unknown: W2's first task is one minimal live turn; exit code 10 means fixtures come from the frames in spec section 5 and `FakeCmdProcess`. Live smoke is opt-in via `OPENADE_LIVE_CMD=1`. **Superseded (2026-09-18):** the plan is paid for, `cmd` is installed at `/opt/homebrew/bin/cmd`, nothing is pinned any more (the fallback asks for `command-code@latest`), and `FakeCmdProcess` is gone — every fixture is a real recording. See `w2-cmd-frames.md`.
- `agent-browser` is **not installed**. W6 uses `npx -y agent-browser@0.37.1` for the spike and adds an install prompt.
- Reference repos exist read-only at `/Volumes/main/Code/ade/{t3code,zuse,synara,opencodex}`; every file the spec cites was verified present. t3code and synara are MIT, zuse is AGPL (read only), Command Code is UNLICENSED (spawn only).

## Process

- One git branch per workstream: `feat/w0-foundation`, `feat/w1-orchestration`, … in a worktree under `.claude/worktrees/<name>`. Each workstream commits feature by feature with plain messages. No AI attribution trailers of any kind.
- Waves and merge order are in `01-plan-review.md` D8: W0; then W1, W2, W3, W7, W8; then W4, W5, W6, W9; then W10 integration.
- `pnpm check` passing in the workstream's own worktree is the precondition for review; review precedes merge.
