# W10 · Composition branch hand-off (2026-09-18)

What the `w10/composition` branch touches beyond the files it was assigned,
so that whoever merges it knows where the conflicts can be. Written after a
review found that a cross-package edit had reached the branch without being
declared — the kind of thing that only hurts at merge time.

## Where the branch starts

Its base is `9f1842c` on `feat/w10-integration`. Everything after that is
this branch's own.

## Edits outside the assigned files

The assignment was the composition root and the seams around it —
`apps/server/src/main.ts`, `boot.ts`, `settings/ConnectorHost.ts`,
`settings/ConnectorManager.ts`, `rpc/services.ts`, `mcp/sessionServices.ts`,
`apps/server/package.json`, `knip.json`, `turbo.json`,
`packages/connector-cmd/src/probe.ts`. These were touched as well:

- **`packages/client-runtime/src/clientState.ts`** (+ `clientState.test.ts`) —
  the client fold for `thread.session.lost` now settles the thread's open
  cards, which is what `apps/server/src/orchestration/state.ts` already does
  on the server. `applyThreadEvent` is a switch the UI-completeness and live
  wiring branches also work in, so this is the one real conflict surface here.
  The queue is deliberately _not_ cleared: a lost session's queued messages
  drain on the user's next turn, and nothing in the renderer gates the
  composer on `status === "error"`, so that is reachable.
- **`apps/server/src/orchestration/SessionManager.ts`** — the registry-backed
  `ConnectorSelection` takes a preference list, so routing follows the
  connectors page's order rather than the order instances were opened in.
- **`apps/server/src/settings/connectorRouting.ts`** (new) — the one reading
  of "which connector a new thread belongs to", shared by that preference
  list and by the engine's model seed.
- **`apps/server/src/orchestration/Engine.ts`** — the seed reads
  `connectorRouting` instead of its own rule, and takes the open-instance list
  through the `OpenConnectors` reference.
- **`apps/server/src/persistence/Sqlite.ts`, `rpc/bootstrap.ts`,
  `rpc/server.ts`, `permissions/PermissionService.ts`, `mcp/McpGateway.ts`,
  `hooks/HookBridge.ts`, `git/Files.ts`, `apps/server/test/layers.ts`,
  `packages/contracts/src/settings.ts`** — follow-on edits from moving the
  graph into `boot.ts` and from the single `ConnectorServices` bundle.

## The stand-in CLI

`apps/server/src/boot.test.ts` no longer runs `packages/testkit/bin/fake-cmd.mjs`;
its connector case proves what the composition root owns and nothing about
that executable. So removing the stand-in does not take this branch's smoke
test with it. `apps/server/src/hooks/cmdConformance.test.ts` still points at
it and belongs to whoever removes it.
