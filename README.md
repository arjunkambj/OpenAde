# OpenAde

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Turborepo** - Optimized monorepo build system
- **Oxlint** - Oxlint + Oxfmt (linting & formatting)
- **Electron** - Cross-platform desktop shell for the web frontend

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

Then, run the development server:

```bash
pnpm dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@OpenAde/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Git Hooks and Formatting

- Run checks: `pnpm check`

## Project Structure

```
OpenAde/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   ├── desktop/     # Electron shell (main + preload, packages the web build)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
```

## Available Scripts

- `pnpm dev`: Start the desktop app with the web dev server (HMR)
- `pnpm build`: Build all applications
- `pnpm dev:web`: Start only the web application
- `pnpm check-types`: Check TypeScript types across all apps
- `pnpm check`: Run Oxlint and Oxfmt
- `pnpm dev:desktop`: Start the Electron desktop app with HMR
- `pnpm build:desktop`: Package the stable Electron desktop app
- `pnpm build:desktop:canary`: Package the canary Electron desktop app

## Desktop App

`apps/desktop` is an Electron shell around the `apps/web` build.

- `src/main/index.ts`: main process — window, custom `openade://app/` scheme that serves
  the built web app (with SPA fallback so the router keeps working)
- `src/preload/index.ts`: sandboxed preload that flags the renderer with
  `data-desktop` / `data-desktop-mac`
- `src/platform/`: everything that branches on OS or build channel, run before
  `app.whenReady`. It reads `<config dir>/desktop.json` (`~/.openade/desktop.json`,
  moved by `OPENADE_HOME`): `{ "browserPane": true }` turns on the in-app browser
  pane, which is what makes Chromium open a loopback remote-debugging port. Off by
  default — the server then drives its own Chromium instead.
- `scripts/build.mjs`: bundles main + preload with esbuild and copies `apps/web/dist`
  into `out/renderer`
- `scripts/dev.mjs`: esbuild watch that restarts Electron and points it at the Vite dev
  server via `ELECTRON_RENDERER_URL`
- `electron-builder.config.cjs`: packaging config; `BUILD_CHANNEL=canary` switches the
  app id, product name, and output directory. The same channel is bundled into the
  app, so the running canary names itself the way its installer did and keeps its
  own userData.
