# W5 · Composer decisions

Short notes on choices in `apps/web/src/components/{composer,approvals,keybindings}`
that are not obvious from the code.

## `/clear` is not offered, `/clear-draft` is

Spec section 11 lists `/clear` next to `/model`, `/effort`, `/mode` and
`/plan`. Those four are thread-level actions; `/clear` in Command Code means
*clear the session context*. The first implementation bound `/clear` to
emptying the textarea, which is the worst of both readings: a user typing
`/clear` to reset a long context loses only the sentence they were writing and
keeps every token they meant to drop, with no way to tell the difference.

The command union has nothing that clears a session's context
(`packages/contracts/src/orchestration.ts`), and inventing one here would mean
a contract, a decider case and a connector call — the connector is the only
thing that can actually drop the context.

So: the draft-clearing item is named `/clear-draft` (it also drops pending
mentions and attachments, which "clear the draft" has to mean), and `/clear`
is not offered at all. When `thread.context.clear` exists, `/clear` can be
added pointing at it, and the two will not be confusable.

## One keybinding mechanism

The renderer has exactly one keydown listener, in `apps/web/src/lib/shortcuts.tsx`,
mounted once in `routes/__root.tsx`. It resolves the pressed chord against the
server-owned table (`settings.keybindings`) with the matcher in
`@OpenAde/client-runtime/keybindings`, and calls whichever handler a mounted
component registered for the resolved command id via `useKeybindingCommand`.

Consequences worth knowing:

- A surface that is not mounted does not answer its command. That is the point:
  `thread.interrupt` belongs to the composer, so it is inert on the settings
  page rather than dispatching into a thread the user is not looking at.
- Interaction cards claim `1`/`2`/`3`/`d`/`Escape` in **capture** phase and
  stop propagation; the composer's trigger menu eats `Escape` first. The global
  listener is in **bubble** phase and skips `defaultPrevented` events, so it
  only ever sees what nothing closer to the focus wanted. Do not move it to
  capture.
- An empty server table falls back to `DEFAULT_KEYBINDINGS`. A renderer with no
  bindings has no shortcuts at all, which is indistinguishable from a bug. Once
  the table has any row it is authoritative — a binding the user removed stays
  removed.
- `ShortcutKbd` and the composer's hint strip read the same table, so a
  rebound chord relabels its own hint.

## The dev fixture pages do not ship

`/dev/composer` and `/dev/timeline` load their page bodies through a dynamic
import inside `if (import.meta.env.DEV)`. In a production build the branch is
dead code, so the fixture modules — including the 465-line scripted client in
`apps/web/src/lib/fixture-client.ts` — are never reached from an entry and are
not emitted. The routes themselves remain in the route tree and render a
one-line "not available in this build" instead of 404ing, which is cheaper than
filtering the route files per mode.
