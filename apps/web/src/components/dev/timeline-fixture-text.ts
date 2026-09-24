/**
 * The words of the timeline fixture's conversation: what the user asks, what
 * the agent answers, and the diffs its edits carry. Kept apart from the
 * builder so `timeline-fixture-data.ts` reads as the shape of the thread.
 *
 * The answers are chosen to exercise the message renderer: fenced code in
 * several languages, a fence with no language, fences whose meta names a file,
 * links and inline code that are workspace paths (and some that only look
 * like them), and two blocks big enough to hit the height cap and the plain
 * fallback.
 */

const FENCE = "```";

// ── What the user says ─────────────────────────────────────────

export const SHORT_ASK = "Add a health check endpoint and cover it in the smoke test.";

/** Over 600 characters and over ten lines, so the bubble has to clamp. */
export const LONG_ASK = [
  "The settings page needs a second pass before the release. Screenshots of today's page and of the mock are attached.",
  "",
  "What I want:",
  "- the banner at the top follows the accent colour instead of the fixed blue",
  "- the sidebar sections keep their order when the window is narrow",
  "- saving shows a quiet confirmation instead of the modal",
  "- the keyboard path still works: Tab through every field, Enter saves, Escape cancels",
  "",
  "Constraints:",
  "- no new dependencies, and nothing in the shared UI package changes",
  "- keep the existing tests passing and add one for the narrow layout",
  "- the settings schema is shared with the server, so any new field needs a default that old files still decode with",
  "",
  "If the build fails anywhere, stop and tell me what broke before you try to fix it. Use the review skill when you are done and run the formatter plugin over what you touched.",
].join("\n");

export const MARKDOWN_ASK = [
  "## Readiness probe",
  "",
  "Next, add a `/readyz` route that:",
  "",
  "1. waits for the **database pool** to answer",
  "2. reports each dependency by name",
  "3. never blocks longer than `2s`",
  "",
  "Something like this, but typed:",
  "",
  `${FENCE}ts`,
  "app.get('/readyz', async () => ({ db: await pool.ping() }))",
  FENCE,
  "",
  "Raw markup such as <b>html</b> must show as text, not bold.",
].join("\n");

export const STEER_ASK = "Also make the timeout configurable from the environment.";

export const LARGE_ASK = "Paste the generated route table and the seed data so I can review them.";

export const RUNNING_ASK = "Now wire the readiness probe into the deploy script and dry-run it.";

/** What the page's Send button says, in turn. */
export const SEND_ASKS = [
  "Run the smoke test against staging and summarise what failed.",
  "Explain what the readiness probe checks, briefly.",
  "Tidy up the deploy script's logging.",
] as const;

// ── What the agent says ────────────────────────────────────────

export const NARRATION = {
  readRouter: "Let me look at how the router mounts its handlers first.",
  runTests: "The route is in. Running the server tests to be sure nothing else moved.",
  testFailed:
    "One test fails: the snapshot still expects the fixed banner colour. Updating the snapshot rather than the component, since the colour change is intended.",
  planFirst: "This touches the deploy path, so here is a plan before any edits.",
  delegate: "I'll have a subagent check which handlers the router never mounts.",
  running: "Checking how the deploy script calls the health endpoints today.",
} as const;

export const REASONING = {
  health:
    "The router already mounts /api, so the liveness check belongs beside it and needs no auth.",
  settings:
    "The banner colour comes from a constant. Swapping it for the accent token keeps both themes right; the narrow layout is a flex-wrap problem, not a breakpoint one.",
  readiness:
    "Readiness needs the pool, liveness does not. A slow database must fail readiness quickly rather than hang the probe.",
  running: "The deploy script polls /healthz; it should poll /readyz after the migration step.",
} as const;

export const ANSWER_HEALTH = [
  "Added `GET /healthz` beside the API router and pointed the smoke test at it.",
  "",
  `${FENCE}ts`,
  'import type { Handler } from "./router";',
  "",
  "export const health: Handler = () => ({",
  "  ok: true,",
  '  sha: process.env.BUILD_SHA ?? "dev",',
  "});",
  FENCE,
  "",
  "The route lives in [health.ts](apps/server/src/http/health.ts) and is mounted in [the router](apps/server/src/http/router.ts:13).",
].join("\n");

export const ANSWER_SETTINGS = [
  "The settings page now follows the accent colour, keeps its section order when narrow, and confirms a save inline.",
  "",
  "### The banner",
  "",
  `${FENCE}tsx`,
  "export function SettingsBanner({ title }: { title: string }) {",
  "  return (",
  '    <header className="bg-primary text-primary-foreground rounded-lg px-4 py-2">',
  "      <h1>{title}</h1>",
  "    </header>",
  "  );",
  "}",
  FENCE,
  "",
  "### The new setting",
  "",
  `${FENCE}json`,
  "{",
  '  "settings": {',
  '    "confirmSave": "inline",',
  '    "sidebarOrder": ["general", "models", "keybindings"]',
  "  }",
  "}",
  FENCE,
  "",
  "### Checks",
  "",
  `${FENCE}bash`,
  "pnpm --filter web test -- settings",
  "pnpm fmt && pnpm check",
  FENCE,
  "",
  "The snapshot change, for the record:",
  "",
  `${FENCE}diff`,
  "-  banner: '#3b82f6',",
  "+  banner: 'var(--primary)',",
  FENCE,
  "",
  "A fence with no language stays a block:",
  "",
  FENCE,
  "settings/",
  "  general.tsx",
  "  models.tsx",
  FENCE,
  "",
  "And fences that name their file:",
  "",
  `${FENCE}ts title="src/app.ts"`,
  'export const APP_NAME = "Poseidon";',
  FENCE,
  "",
  `${FENCE}ts apps/web/src/lib/format.ts`,
  'export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;',
  FENCE,
].join("\n");

export const ANSWER_READINESS = [
  "`/readyz` is live. It pings the pool with a timeout read from `READYZ_TIMEOUT_MS` (default 2000).",
  "",
  "Where things are:",
  "",
  "- the entry point is [main.tsx](apps/web/src/main.tsx:12)",
  "- the probe is documented in [the readme](README.md#L3)",
  "- the RPC it answers through is [rpc.ts](/fixture/packages/contracts/src/rpc.ts), its stat call at [L640](packages/contracts/src/rpc.ts#L640-L652)",
  "- the host file I did **not** touch is [hosts](/etc/hosts)",
  "",
  "Inline paths: `apps/server/src/http/ready.ts`, `docs/architecture.md:40` and `package.json`.",
  "Two files share a name: `apps/web/src/lib/format.ts` and `packages/shared/src/format.ts:7`.",
  "Not paths: `npm test`, `--flag`, `a/b`, `src/*.ts`, and `v1.2.3`.",
].join("\n");

/** Short lines, so the 420-line block stays well under the highlighting size cap. */
const routeLine = (index: number): string => `  r${index}: "/api/v1/r${index}",`;

const seedLine = (index: number): string =>
  `{"id":${index},"email":"user${index}@example.test","name":"Seed User ${index}","roles":["reader","writer"],"createdAt":"2026-01-01T00:00:00.000Z"}`;

/**
 * Over 400 lines of TypeScript (about 12,000 characters, so it still
 * highlights), then over 20,000 characters of JSON.
 */
export const ANSWER_LARGE = [
  "Here is the generated route table (420 routes):",
  "",
  `${FENCE}ts`,
  "export const routes = {",
  ...Array.from({ length: 420 }, (_, index) => routeLine(index)),
  "} as const;",
  FENCE,
  "",
  "And the seed data:",
  "",
  `${FENCE}json`,
  "[",
  ...Array.from({ length: 180 }, (_, index) => `${seedLine(index)},`),
  "]",
  FENCE,
].join("\n");

// ── Diffs the edits carry ──────────────────────────────────────

export const DIFF_HEALTH = [
  "--- /dev/null",
  "+++ b/apps/server/src/http/health.ts",
  "@@ -0,0 +1,6 @@",
  '+import type { Handler } from "./router";',
  "+",
  "+export const health: Handler = () => ({",
  "+  ok: true,",
  '+  sha: process.env.BUILD_SHA ?? "dev",',
  "+});",
  "",
].join("\n");

export const DIFF_ROUTER = [
  "--- a/apps/server/src/http/router.ts",
  "+++ b/apps/server/src/http/router.ts",
  "@@ -1,4 +1,5 @@",
  ' import { api } from "./api";',
  '+import { health } from "./health";',
  " ",
  " export const router = makeRouter()",
  '   .mount("/api", api)',
  "@@ -12,2 +13,3 @@ export const router = makeRouter()",
  '   .get("/version", version)',
  '+  .get("/healthz", health)',
  "   .fallback(notFound);",
  "",
].join("\n");

export const DIFF_SMOKE = [
  "--- a/scripts/smoke.sh",
  "+++ b/scripts/smoke.sh",
  "@@ -3,3 +3,3 @@",
  ' BASE_URL="${BASE_URL:-http://localhost:3000}"',
  '-curl -fsS "$BASE_URL/api/version"',
  '+curl -fsS "$BASE_URL/healthz"',
  ' echo "smoke ok"',
  "",
].join("\n");

export const DIFF_BANNER = [
  "--- a/apps/web/src/settings/banner.tsx",
  "+++ b/apps/web/src/settings/banner.tsx",
  "@@ -1,7 +1,7 @@",
  " export function SettingsBanner({ title }: { title: string }) {",
  "   return (",
  '-    <header style={{ background: "#3b82f6" }} className="rounded-lg px-4 py-2">',
  '+    <header className="bg-primary text-primary-foreground rounded-lg px-4 py-2">',
  "       <h1>{title}</h1>",
  "     </header>",
  "   );",
  " }",
  "",
].join("\n");

export const DIFF_BANNER_TEST = [
  "--- a/apps/web/src/settings/banner.test.tsx",
  "+++ b/apps/web/src/settings/banner.test.tsx",
  "@@ -8,3 +8,3 @@",
  "   expect(tokens(banner)).toMatchObject({",
  "-    banner: '#3b82f6',",
  "+    banner: 'var(--primary)',",
  "   });",
  "",
].join("\n");

export const DIFF_SAVE_MODAL = [
  "--- a/apps/web/src/settings/save-modal.tsx",
  "+++ /dev/null",
  "@@ -1,5 +0,0 @@",
  "-export function SaveModal({ open }: { open: boolean }) {",
  "-  return open ? <dialog open>Saved</dialog> : null;",
  "-}",
  "-",
  "-export default SaveModal;",
  "",
].join("\n");

export const DIFF_READY = [
  "--- /dev/null",
  "+++ b/apps/server/src/http/ready.ts",
  "@@ -0,0 +1,8 @@",
  '+import { pool } from "../db/pool";',
  "+",
  "+const TIMEOUT = Number(process.env.READYZ_TIMEOUT_MS ?? 2000);",
  "+",
  "+export const ready = async () => ({",
  "+  db: await pool.ping({ timeout: TIMEOUT }),",
  "+});",
  "+",
  "",
].join("\n");

export const DIFF_READY_TIMEOUT = [
  "--- a/apps/server/src/http/ready.ts",
  "+++ b/apps/server/src/http/ready.ts",
  "@@ -1,3 +1,4 @@",
  ' import { pool } from "../db/pool";',
  '+import { env } from "../env";',
  " ",
  "-const TIMEOUT = Number(process.env.READYZ_TIMEOUT_MS ?? 2000);",
  "+const TIMEOUT = env.readyzTimeoutMs;",
  "",
].join("\n");

export const DIFF_DEPLOY = [
  "--- a/scripts/deploy.sh",
  "+++ b/scripts/deploy.sh",
  "@@ -20,2 +20,2 @@ migrate",
  " restart_service",
  '-wait_for "$HOST/healthz"',
  '+wait_for "$HOST/readyz"',
  "",
].join("\n");

// ── The Stream toggle ──────────────────────────────────────────

/** What the Stream toggle types out, a few words per tick. */
export const STREAM_TEXT = [
  "The deploy script now waits on `/readyz` after the migration step, so a slow database holds the rollout instead of failing it.",
  "",
  "What changed:",
  "",
  "- `scripts/deploy.sh` polls the readiness route",
  "- the poll gives up after 60 seconds and prints the last response",
  "- the dry run passes against the staging config",
  "",
  `${FENCE}bash`,
  "wait_for() {",
  '  for _ in $(seq 1 60); do curl -fsS "$1" && return 0; sleep 1; done',
  "  return 1",
  "}",
  FENCE,
  "",
  "Next I would add the same wait to the rollback path, which still restarts blind.",
].join("\n");

/** Words (with their trailing space) each Stream tick appends. */
const WORDS_PER_TICK = 3;

/**
 * The streamed text after one more tick: `current` is a prefix of
 * `STREAM_TEXT`, and the result is the next few words longer, or the whole
 * text once it runs out.
 */
export const streamedText = (current: string): string => {
  let end = current.length;
  for (let word = 0; word < WORDS_PER_TICK && end < STREAM_TEXT.length; word += 1) {
    const space = STREAM_TEXT.slice(end).search(/\s\S/);
    end = space === -1 ? STREAM_TEXT.length : end + space + 1;
  }
  return STREAM_TEXT.slice(0, end);
};
