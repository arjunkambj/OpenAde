# 02 · W0 contract and gate notes (2026-09-15)

Spec section 6 says "Field names are final unless a decision doc says otherwise",
and `01-plan-review.md` left sections 6, 7 and 16 standing as written. W0's code
departs from the spec sketch in five places. Each is deliberate; this file is the
"unless". Later workstreams follow the packages, not the sketch, for these five
points and follow the spec everywhere else.

Two earlier departures were mistakes rather than decisions and are now gone:
`Attachment` carries the spec's `mime` again, and the database is at the spec's
`~/.openade/state.sqlite`.

## N1 RuntimeEvent variants nest their fields under `payload`

The spec sketches `RuntimeEventEnvelope` with no `payload` key and then lists
each variant's fields inline, e.g. `session.started { sessionRef, model,
capabilities }`. `packages/contracts/src/runtime.ts` gives all 23 variants an
explicit `payload` struct instead, the way the spec itself already does for
`OrchestrationEvent`.

Every variant name, field name and literal is the spec's. The nesting is what
changes, and it is what lets the envelope be one shared struct that a projection,
a persister or a log line can read without knowing the variant. W2's translator
writes `{ ...envelope, type: "turn.completed", payload: { turnId, stopReason } }`,
not `{ ...envelope, type: "turn.completed", turnId, stopReason }`.

The fixtures under `packages/contracts/fixtures/runtime-events/` are the
authority; every one of them round-trips in CI.

## N2 `Mention` is a path string

`TurnInput.mentions` is `FileRef[]` in spec section 7, but `FileRef` is defined
nowhere in the spec. `packages/contracts/src/orchestration.ts` declares
`Mention = NonEmptyString`: a workspace-relative path, which is all Command Code
needs — the connector expands each one into `@path` text and Command Code
resolves the path itself (spec section 8, step 1).

W5's composer sends paths. If a mention ever needs a range or a symbol, that is a
new struct and a new entry here, not a quiet widening of this one.

## N3 `pnpm check` also runs knip

D5 defines the gate as "lint, format check, typecheck, test, boundary check,
file-size check". The root `check` script runs `knip` as a seventh step, because
spec section 16 lists "knip for dead exports" among the guardrails CI enforces
from M0 and nothing else in the gate reads for them.

So: `pnpm check` = lint, format check, typecheck, test, boundary check, file-size
check, knip. `knip.json` is a shared root file under W0's ownership (D8); a
workstream adding a stub whose exports are not used yet adds its own
`ignoreDependencies` or `ignore` entry there and says so in its commit.

Packages consumed as TypeScript source (D1) need one more thing before knip can
see anything: every `exports` entry is an entry point, so by default every
symbol a package exports counts as used. Each `packages/*` workspace therefore
sets `includeEntryExports` — knip looks inside the entry files — together with
`ignoreExportsUsedInFile`, so a schema that is exported and also composed
further down its own module is not reported.

Two escape hatches, both narrow:

- An export that is deliberate API with no consumer on this branch is tagged
  `@public` in its own JSDoc, with a line saying which workstream will call it.
  `tags: ["-@public"]` makes knip skip it. `toWireProbe` in the connector SDK is
  the only one today.
- `packages/contracts/src/ids.ts` ignores `exports` wholesale. The file is
  nothing but `defineId` triples — `[Schema, makeX, decodeX]` — and the triple is
  uniform on purpose: the decoders exist for the transport boundary W3 builds.
  Tagging nine declarations one by one would say less than this sentence does.

## N4 `apps/web` may import `@OpenAde/ui`

Spec section 4 writes the renderer rule as "web imports only contracts,
client-runtime, shared". The allowlist in `scripts/check-boundaries.mjs` adds
`ui`, because the pre-existing design system stays and `apps/web` already renders
through it (`00-plan-adaptation.md`, "Root and layout").

The enforced list is `["ui", "contracts", "client-runtime", "shared"]`. Nothing
else widens: `apps/web` still may not reach a connector package, the server or
testkit, and nothing in `apps/web` restyles `packages/ui` (D10).

## N5 `apps/server` may import `@OpenAde/testkit`, but only from its tests

Spec section 4 constrains only `web` and `connector-*`, so nothing there says
where the fakes may go. `scripts/check-boundaries.mjs` decides it: the server's
production list is `["contracts", "connector-sdk", "connector-cmd", "shared"]`,
and `TEST_ONLY_ALLOWLIST` adds `testkit` for files named `*.test.*` / `*.spec.*`.

The split matters because `apps/server` is bundled by esbuild to
`out/main.cjs` for packaging (D1). `FakeConnector` and `FakeCmdProcess` are what
W1 and W3 drive their tests with, so the server's tests need them; an import
from `src/main.ts` would put a test framework in the shipped bundle, and now
fails the gate instead.

A workstream that needs the same split elsewhere adds its workspace to
`TEST_ONLY_ALLOWLIST` and says so in its commit. `apps/web` is deliberately not
in it: the renderer does not reach testkit, in tests or out of them.
