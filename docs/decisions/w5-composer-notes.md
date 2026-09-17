# W5 · Composer decisions

Short notes on choices in `apps/web/src/components/{composer,approvals,keybindings}`
that are not obvious from the code.

## `/clear` is not offered, `/clear-draft` is

Spec section 11 lists `/clear` next to `/model`, `/effort`, `/mode` and
`/plan`. Those four are thread-level actions; `/clear` in Command Code means
_clear the session context_. The first implementation bound `/clear` to
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
  removed. The settings editor shows that same effective table, not the raw
  one: showing the empty list would let a user add one row, save, and silently
  unbind everything else.
- `packages/ui`'s `SidebarProvider` used to run its own hard-coded Cmd/Ctrl+B
  listener. It is gone. A vendored component that listens for keys is a second
  mechanism by another name: the old chord kept working after a rebind, and
  with no `defaultPrevented` guard the result depended on which listener
  registered first. `sidebar.toggle` is registered by `SearchProvider` like
  every other shell command.
- `ShortcutKbd` and the composer's hint strip read the same table, so a
  rebound chord relabels its own hint.

## The queue strip owns nothing

Both halves of spec section 11's "reorder and remove" go through the decider:
`thread.queue.remove` emits `thread.message.dequeued`, `thread.queue.reorder`
emits `thread.queue.reordered`. The strip never mutates its own list — a row
moves or disappears when the event lands, so it cannot disagree with the server
about what is still going to be sent.

Two shapes worth keeping:

- The reorder event carries the **whole resulting order**, not the move. Both
  folds (`apps/server/src/orchestration/state.ts` and the client runtime's)
  apply it as a rank lookup, so an id the queue no longer holds simply places
  nothing and a message the order does not mention keeps its place behind the
  ones it does. Replaying a from/to pair against a queue that has since drained
  would not survive that.
- The drain is decided **inside the write transaction**. On
  `thread.turn.completed` the reactor hands `appendThreadEvents` a planner
  rather than a list, and that planner picks `doc.queue[0]` from the doc the
  transaction holds. Reading the queue outside and appending afterwards left a
  window where a `thread.queue.remove` was accepted — the row left the strip,
  the user saw success — and the retracted message was sent anyway.

## The dev fixture pages do not ship

`/dev/composer` and `/dev/timeline` load their page bodies through a dynamic
import inside `if (import.meta.env.DEV)`. In a production build the branch is
dead code, so the fixture modules — including the 465-line scripted client in
`apps/web/src/lib/fixture-client.ts` — are never reached from an entry and are
not emitted. The routes themselves remain in the route tree and render a
one-line "not available in this build" instead of 404ing, which is cheaper than
filtering the route files per mode.
