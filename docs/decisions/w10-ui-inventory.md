# W10 · UI inventory

Every surface spec section 11 (Renderer), section 12 (Browser) and the UI
deliverables of W4, W5, W6, W8 and W9 in section 14 ask for, with what it
actually is on this branch and where it lives.

**Status** is one of:

- **real** — mounted in the app, wired to live atoms, with honest empty,
  loading and error states.
- **fixed here** — it was placeholder, unmounted, wrong or dead before this
  wave; the commit that changed it is named.
- **gap** — still missing or limited, with the reason.

Paths are relative to the repository root. Everything below was exercised
against a running server (`apps/server` with `OPENADE_HOME` pointed at a scratch
directory, `apps/web` on Vite) with the connector instance's binary path set to
`packages/testkit/bin/fake-cmd.mjs`, so no real harness credits were spent.

## Routes

| Surface                                          | Status     | File                                                                        |
| ------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| `/` — start a thread, project pick               | real       | `apps/web/src/routes/_home/index.tsx`, `components/thread/start-thread.tsx` |
| `/t/$threadId` — thread view, `?pane=` dock tab  | real       | `apps/web/src/routes/_home/t/$threadId.tsx`                                 |
| `/settings` + five sections                      | real       | `apps/web/src/routes/settings*.tsx`                                         |
| `/welcome` — first run and connection diagnostic | fixed here | `apps/web/src/routes/welcome.tsx`                                           |
| `/browser/$threadId` — the pane's webview target | real       | `apps/web/src/routes/browser.$threadId.tsx`                                 |
| Not-found route                                  | real       | `apps/web/src/routes/__root.tsx`                                            |
| Error boundary                                   | fixed here | `components/Layout/error-screen.tsx`, wired in `main.tsx`                   |
| `/dev/timeline`, `/dev/composer`, `/dev/changes` | fixed here | `apps/web/src/routes/dev/*`, `components/dev/*`                             |

`/welcome` was the blocker: its "Project directory" field was a `CommitInput`,
which publishes what was typed only on blur. "Create project" is disabled while
that published value is empty, and a disabled button takes no pointer events —
so on a fresh install, where this route is the only way in, typing a path left
the button disabled and clicking it could not blur the field to enable it. The
field is now live, the rule lives in `components/welcome/project-directory.ts`
with its test, and a server rejection's reason is shown under the field instead
of only in a toast.

`/dev/changes` imported `contracts/fixtures/thread-detail-snapshot.json` at
module scope, so a production build shipped the whole fixture thread. It now
loads its page body through the same `import.meta.env.DEV` dynamic import the
other two fixture routes use; a rebuild confirms no fixture id appears in
`dist/assets`.

## Layout

| Surface                                    | Status     | File                                                              |
| ------------------------------------------ | ---------- | ----------------------------------------------------------------- |
| Left sidebar: projects → threads           | real       | `components/sidebar/project-tree.tsx`                             |
| Thread status indicator                    | fixed here | `components/sidebar/project-tree.tsx` (gained an accessible name) |
| Unread dot                                 | fixed here | `components/sidebar/thread-seen.ts`                               |
| Sidebar footer                             | fixed here | `components/sidebar/sidebar-user.tsx`, `sidebar-footer-state.ts`  |
| Add project                                | real       | `components/sidebar/add-project-dialog.tsx`                       |
| Center thread view                         | real       | `components/thread/thread-view.tsx`                               |
| Right dock, tabs changes / browser / files | real       | `components/dock/right-dock.tsx`                                  |
| Per-thread tab state persisted             | real       | `state/ui.ts` (`useDockTabMemory`) + `?pane=`                     |
| Dock toggle and resize                     | real       | `components/dock/right-dock.tsx`                                  |
| Behaviour under 768px                      | fixed here | `components/dock/right-dock.tsx`                                  |
| Window chrome back / forward               | fixed here | `components/Layout/window-chrome.tsx`                             |
| Connection banner                          | real       | `components/Layout/connection-banner.tsx`                         |
| Toasts for failed dispatches               | real       | `lib/dispatch-result.ts` callers + `__root.tsx` `Toaster`         |
| Command palette                            | real       | `components/Layout/search-command.tsx`                            |

There is no `unread` flag on the wire and there should not be one — whether this
window has looked at a thread is not the server's business. The renderer
remembers the `updatedAt` each thread was last open at and marks any thread that
has moved past its own stamp. A thread with no stamp is deliberately _not_
unread, so a fresh install restoring old threads does not light every row up.

Below 768px the dock used to be `hidden md:flex` with an equally hidden toggle,
which made the changes, browser and files tabs unreachable on a narrow window
with nothing on screen to say they existed. It is now an overlay over the thread
column at that width; the drag-to-resize edge stays behind `md`, because there
is nothing to resize when the panel is already full width.

The sidebar footer shipped a hardcoded account name and a Feedback button with
no handler. OpenAde has no accounts, so the slot now reports which server this
window is talking to and links to `/welcome`. The window chrome's back and
forward buttons were rendered permanently `disabled`; they now drive the
router's history.

## Dock panes

| Surface                                                                                   | Status         | File                                          |
| ----------------------------------------------------------------------------------------- | -------------- | --------------------------------------------- |
| Changes: turn selector, per-file list with stats, worker diffs, restore with confirmation | real           | `components/panes/changes/*`                  |
| Browser: no session / starting / agent driving / human control                            | fixed here     | `components/panes/browser/*`                  |
| Browser: agent-browser missing → install prompt                                           | real           | `components/panes/browser/install-prompt.tsx` |
| **Files: searchable list, drill-in, read-only preview**                                   | **fixed here** | `components/panes/files/*`                    |
| Files atoms                                                                               | new            | `packages/client-runtime/src/fileAtoms.ts`    |

The Files tab was a placeholder reading "No workspace files to show yet". It is
now a search over the project's ignore-aware listing (`files.search`), a
directory row that drills in by searching its own prefix, and a read-only
preview with line numbers over `files.read`. The preview **pages**: `files.read`
answers a line window plus the file's real line count, so page 41 of a
20,000-line file is a request rather than a scroll into a cap the server will
not lift. Verified live on this repository's own `pnpm-lock.yaml`
(10,181 lines, paged to lines 2,501–3,000) and on `apps/web/public/favicon.png`,
which reports as binary rather than rendering mojibake.

A project that is not a git repository needs nothing special here: the server
already falls back to an ignore-aware filesystem walk, and this tab reads no git
state at all.

The browser pane's frame surface fell back to `state.message ?? "starting…"`,
so a thread that had never made a browser call read "starting…" in the body
while the status chip above it read "stopped". A stopped session now gets the
pane's own "it starts on the first agent call" block, and the placeholder is a
function of the status with a test per state.

## Timeline

| Surface                                           | Status     | File                                                                |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| Every `ItemKind` row                              | real       | `components/timeline/*`, dispatched in `timeline-item.tsx`          |
| `mcp_tool_call` including `browser_*`             | real       | `components/timeline/tool-rows.tsx`                                 |
| Nested `task` rows                                | real       | `components/timeline/task-row.tsx`                                  |
| Inline `file_change` diff through the worker pool | real       | `components/timeline/file-change-row.tsx`, `diff-pool.tsx`          |
| Settled turns fold to "Worked for Ns · N tools"   | real       | `components/timeline/fold.ts`, `lib/format.ts`                      |
| Disclosure state keyed by itemId                  | real       | `state/ui.ts` (`useRowDisclosure`)                                  |
| `/dev/timeline` in both themes                    | fixed here | `components/dev/timeline-fixture.tsx`, `components/mode-toggle.tsx` |

`contracts/fixtures/thread-detail-snapshot.json` carries all fifteen kinds, and
the fixture page renders them. The theme button on that page did nothing against
a live server: `settings.theme` is the truth and `SettingsThemeSync` above the
routes pushes it into next-themes whenever the settings doc ticks, so a toggle
that only called `setTheme` was reverted at once. It now writes the setting, as
the Appearance page does.

A fold label omits the duration when the group spans under a second — ids are
UUIDv7 and the millisecond field is where the duration comes from, so
"Worked · 1 tool" is the honest reading of a group that took no measurable time.

## Composer, cards and header controls

| Surface                                                                | Status     | File                                                           |
| ---------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Composer textarea, mounted in the thread view                          | real       | `components/composer/composer.tsx`                             |
| `/` popover: `/model`, `/effort`, `/mode`, `/plan`, `/default`, skills | real       | `components/composer/slash-menu.tsx`                           |
| `@` file search inserting a chip                                       | real       | `components/composer/composer-chips.tsx`, `trigger-menu.tsx`   |
| Enter / Shift+Enter / Cmd+Enter                                        | real       | `components/composer/composer.tsx`                             |
| Queue strip with reorder and remove                                    | real       | `components/composer/queue-strip.tsx`                          |
| Send becomes Queue while running; visible Stop                         | fixed here | `components/composer/composer.tsx`                             |
| Approval card: once / session / always with editable pattern / deny    | real       | `components/approvals/approval-card.tsx`, `pattern-editor.tsx` |
| Question card                                                          | real       | `components/approvals/question-card.tsx`                       |
| Plan card: accept / accept and run / revise                            | real       | `components/approvals/plan-card.tsx`                           |
| One active card at a time                                              | real       | `components/composer/pending-card.tsx`                         |
| Header controls with capability wiring and "applies next turn"         | real       | `components/header-controls.tsx`                               |

The composer derived "a turn is running" from `currentTurnId` alone. The client
projection fills that id on `thread.turn.started`, one event after status goes
to `running` on `thread.turn.requested` — so in between, with a connector that
is slow to start, the send button still read "Send", no Stop was offered and the
interrupt binding was inactive. `lib/turn.ts`'s `turnInFlight` exists for
exactly this and the header and timeline already used it; the composer was the
last reader on the narrow test.

`/clear` is deliberately absent and `/clear-draft` takes its place — in Command
Code `/clear` drops the session context and no command in the union does that
yet. That decision and its reasoning are in
`docs/decisions/w5-composer-notes.md`; it is a documented deviation from spec
section 11, not an oversight.

## Settings and welcome

| Surface                                             | Status     | File                                                          |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| General                                             | real       | `components/Settings/general-panel.tsx`                       |
| Connectors: schema-driven form + probe details      | real       | `components/Settings/connectors-panel.tsx`, `schema-form.tsx` |
| MCP servers                                         | real       | `components/Settings/mcp-panel.tsx`, `mcp-server-dialog.tsx`  |
| Skills                                              | real       | `components/Settings/skills-panel.tsx`                        |
| Keybindings                                         | real       | `components/keybindings/*`                                    |
| Appearance: system / light / dark                   | real       | `components/Settings/theme-cards.tsx`                         |
| Closed `<Select>` shows its label                   | fixed here | `components/Settings/select-label.ts`                         |
| Shell shortcuts on settings routes                  | fixed here | `components/Layout/settings-layout.tsx`                       |
| Welcome: pick project, verify harness, billing link | fixed here | `routes/welcome.tsx`, `components/Settings/probe-help.ts`     |

base-ui's `Select.Value` renders the raw _value_ unless it is handed a
formatter: the items live in a portal that is unmounted while the popup is
closed, so there is no value → label registry. Every picker whose value differs
from its label was showing the value — General read a bare provider-qualified
model id, and the MCP and Skills scope pickers read the `__user__` sentinel that
exists only because a select item cannot hold `null`.

`SearchProvider` claims the thread-independent half of the keybinding table, and
it was mounted only inside `HomeLayout`, so Cmd+K, Cmd+N and Cmd+, did nothing
on any `/settings/*` route.

## Guardrails

| Rule                                            | Status                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| No component file over 400 lines                | holds (`scripts/check-file-sizes.mjs`)                                                                                           |
| Components never call the RPC client directly   | holds — the files pane goes through `fileAtoms` on the app's one `AtomRuntime`, the way the changes pane goes through `gitAtoms` |
| No connector-specific strings in `apps/web/src` | holds (`scripts/check-boundaries.mjs`)                                                                                           |
| No demo data in the production bundle           | holds — see `/dev/changes` above; a rebuild carries no fixture id, and the sidebar's fake account name is gone                   |

## Known gaps

1. **The files tab has no listing for an empty query.** `files.search` answers
   `[]` for an empty query by design, and there is no directory-listing RPC, so
   the tab opens on "Search this project's files" rather than on a tree of the
   root. Drilling in works once a query matches a directory. Closing this
   properly is a server change (`apps/server/src/git/Files.ts`), which is
   another area's file.
2. **next-themes logs a React 19 console error on every route.** It renders an
   inline `<script>` for the no-flash path, which React 19 reports as
   "Encountered a script tag while rendering React component". The script is
   inert in a client-only SPA. Silencing it means dropping the dependency and
   writing the provider by hand, which is a lockfile change and a theme-
   behaviour change; it was left alone deliberately.
3. **No DOM-level component tests.** `apps/web`'s vitest project runs in the
   `node` environment and the workspace carries no jsdom or testing-library, so
   every surface here is covered by tests over the pure module beside the
   component (the pattern `fold.ts`, `selection.ts`, `status.ts` already set),
   plus a hand-driven pass through a real browser against a real server. Adding
   a DOM environment is a dependency and lockfile change.
4. **The welcome flow cannot show a "directory does not exist" error**, because
   the server accepts `project.create` for a path that is not there. The
   renderer half is done — a rejection's reason renders under the field — but
   nothing rejects. Validating the root is server work.
5. **The sidebar shows a status icon, not a status pill.** Section 11 says
   "status pill"; the row is 8px tall and a pill does not fit beside the title.
   The icon now carries the status as its accessible name.
