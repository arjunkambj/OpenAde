# OpenAde

Bun + Turborepo desktop/web app. The Vite SPA in `apps/web` is the product UI. Electrobun in `apps/desktop` wraps it. Shared shadcn (Base UI, `base-rhea`, zinc) lives in `packages/ui`.

This is not Next.js. There is no App Router, no RSC, and no `"use client"`.

## Commands

Package manager is Bun (`packageManager` in the root `package.json`). Use the workspace catalog for shared versions.

| Task | Command |
|---|---|
| Install | `bun install` |
| Desktop + web (default) | `bun run dev` |
| Web only | `bun run dev:web` (Vite, port **3001**, `strictPort`) |
| Lint + format | `bun run check` (`oxlint` then `oxfmt --write`) |
| Types | `bun run check-types` |
| Production web | `bun run build` (skips desktop, then builds it) |
| Desktop package | `bun run build:desktop` / `bun run build:desktop:canary` |

Assume the dev server is already running (web on `http://localhost:3001`, and desktop if that is what you are verifying). Do not start `bun run dev` or `bun run dev:web`. Do not wait for it, restart it, or treat a missing process as something you need to launch.

Add shared UI with `bunx --bun shadcn@latest add <name> -c packages/ui`. App-only blocks: run the same CLI from `apps/web`.

Do not commit `apps/web/src/routeTree.gen.ts` (TanStack Router generates it). Do not commit `.hutch/` or `apps/web/dist`.

## Layout

```
apps/web          React 19 SPA: Vite 8, TanStack Router, Tailwind v4
apps/desktop      Electrobun 2 cottontail process; CEF view of the web app
packages/ui       @OpenAde/ui — primitives, tokens, chat pieces, Icon
packages/config   @OpenAde/config — shared tsconfig only
```

`@OpenAde/env` is a leftover from Better-T-Stack. It is not a source package. Do not add it back.

### Web routes

File routes under `apps/web/src/routes/`. Layouts are pathless or nested route files that render `Outlet`.

- `/_home` → `HomeLayout` (app sidebar). Pages: `/` (`_home/index`), `/skills`
- `/settings` → `SettingsLayout`. Pages: `/settings` (general/theme), `/settings/uses`

Screens and chrome belong in `apps/web/src/components/` (`Layout/`, `Settings/`, `Chat/`). Keep `packages/ui` to reusable primitives.

### Desktop shell

`apps/desktop/src/bun/index.ts` opens a frameless CEF window (`titleBarStyle: "hiddenInset"`). Dev waits for `http://localhost:3001`; packaged builds load `views://mainview/index.html` (copied from `apps/web/dist`).

The preload sets `data-desktop` and, on macOS, `data-desktop-mac`. That last attribute sets `--traffic-lights-width`. Titlebar hit-testing uses `app-region-drag` / `app-region-no-drag` (see `window-chrome.tsx` and `packages/ui/src/styles/globals.css`).

Electrobun types come from `.hutch/devkit` after `electrobun sync`.

## TypeScript and style

Root TS is `strict` with `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`. ESM everywhere (`"type": "module"`).

- Functional components. React 19: no `forwardRef`.
- `const` unless reassignment is required.
- Match nearby files for imports and naming. Named exports for components except existing defaults (`Header`, `Loader`).
- `cn()` for conditional classes. Prefer `@OpenAde/ui/lib/utils` over the copy in `apps/web/src/lib/utils.ts`.

## UI

Read the shadcn skill before adding or restyling components.

**Imports**

```tsx
import { Button } from "@OpenAde/ui/components/button";
import { cn } from "@OpenAde/ui/lib/utils";
import { Icon } from "@/lib/icon"; // re-exports @OpenAde/ui/lib/icon
```

App alias: `@/*` → `apps/web/src/*`. UI package alias: `@OpenAde/ui/*` → `packages/ui/src/*`.

**Base UI, not Radix.** Slotting uses `render`, not `asChild`:

```tsx
<SidebarMenuButton render={<Link to="/settings" />} isActive={isSettings}>
```

**Icons.** Solar via Iconify, offline collection. `<Icon icon="solar:settings-linear" />`. Do not start using `lucide-react` even though `components.json` still lists `iconLibrary: "lucide"`.

**Tokens.** Edit `packages/ui/src/styles/globals.css` only. `apps/web/src/index.css` is an import of that file. Semantic colors (`bg-background`, `text-muted-foreground`). No raw palettes on product UI, no `space-x-*` / `space-y-*` (use `flex` + `gap-*`), no `dark:` color overrides, no extra `z-index` on overlays.

**Chat.** Compose `MessageScroller`, `Message`, `Bubble`, `Attachment`, and `Marker` from `@OpenAde/ui`. Do not hand-roll bubbles or sticky-scroll.

**Theming.** `next-themes`, class strategy, storage key `vite-ui-theme`, default `dark`.

## Skills

Project skills in `.agents/skills/`:

- `shadcn` when adding, changing, or composing UI
- `vercel-react-best-practices` for React performance
- `vercel-composition-patterns` for compound components and API shape
- `web-design-guidelines` when asked to review UI/a11y
