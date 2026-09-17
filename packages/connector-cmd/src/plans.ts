/**
 * Reading the plan a plan-mode turn leaves behind (spec sections 5.6 and 8).
 *
 * Plan mode puts a markdown file in `~/.commandcode/plans/`. Interactive
 * sessions also record it in `plans-index.json` beside it — `{ version, plans:
 * { <file>: { title, sessionId, cwd, status, createdAt, updatedAt,
 * annotations[] } } }` — and that entry's `sessionId` is the clean way to tell
 * which session wrote which plan.
 *
 * **Print mode does not write that index.** In `fixtures/cmd/plan/` the model
 * puts the plan there with an ordinary `write_file` and `plans-index.json` is
 * untouched — on this machine it has not changed since two interactive sessions
 * in August. An index-only lookup therefore never proposes anything from a
 * headless plan turn, which is every plan turn this connector runs.
 *
 * So the index is consulted first and a file the turn itself created is the
 * fallback: the newest `.md` in the plans directory whose mtime is at or after
 * the moment the turn was spawned. `since` is what keeps that from proposing
 * somebody else's month-old plan.
 *
 * A plan-mode turn that produced no plan is a normal outcome, so every failure
 * here resolves to "nothing proposed".
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface PlanProposal {
  /** Absolute path of the plan's markdown file. */
  readonly planPath: string;
  readonly markdown: string;
  /**
   * The index entry's updatedAt, normalized to a comparable number — part of
   * the dedupe key so a revised plan re-proposes while an unchanged one does
   * not.
   */
  readonly updatedAt: number;
}

export const plansDirFor = (home?: string): string =>
  NodePath.join(home ?? NodeOS.homedir(), ".commandcode", "plans");

export const plansIndexPathFor = (home?: string): string =>
  NodePath.join(plansDirFor(home), "plans-index.json");

interface PlansIndexEntry {
  readonly sessionId?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

/** Index timestamps may be epoch millis or ISO strings — both land here. */
const timeOf = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

/** The newest `plans-index.json` entry recorded against `sessionId`. */
const fromIndex = (sessionId: string, home?: string): { file: string; at: number } | null => {
  let index: unknown;
  try {
    index = JSON.parse(NodeFS.readFileSync(plansIndexPathFor(home), "utf8"));
  } catch {
    return null;
  }
  const plans = (index as { readonly plans?: unknown }).plans;
  if (typeof plans !== "object" || plans === null) {
    return null;
  }
  let best: { file: string; at: number } | null = null;
  for (const [file, entry] of Object.entries(plans)) {
    const record = entry as PlansIndexEntry;
    if (record.sessionId !== sessionId) {
      continue;
    }
    const at = timeOf(record.updatedAt) || timeOf(record.createdAt);
    if (best === null || at >= best.at) {
      best = { file, at };
    }
  }
  return best;
};

/**
 * The newest plan markdown written at or after `since` — the headless fallback,
 * because print mode leaves `plans-index.json` alone. A one-second allowance
 * absorbs the gap between our clock and the file system's.
 */
const MTIME_SLACK_MS = 1000;

const writtenThisTurn = (since: number, home?: string): { file: string; at: number } | null => {
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(plansDirFor(home), { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { file: string; at: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    let at: number;
    try {
      at = NodeFS.statSync(NodePath.join(plansDirFor(home), entry.name)).mtimeMs;
    } catch {
      continue;
    }
    if (at + MTIME_SLACK_MS < since) {
      continue;
    }
    if (best === null || at > best.at) {
      best = { file: entry.name, at };
    }
  }
  return best;
};

/**
 * The plan this session's turn left behind, with its markdown — or null when
 * there is none. `since` is when the turn was spawned; without it only the
 * index is consulted, which in print mode means nothing is ever found.
 */
export const readPlanProposal = (
  sessionId: string,
  home?: string,
  since?: number,
): PlanProposal | null => {
  const best =
    fromIndex(sessionId, home) ?? (since === undefined ? null : writtenThisTurn(since, home));
  if (best === null) {
    return null;
  }
  const planPath = NodePath.join(plansDirFor(home), best.file);
  try {
    return { planPath, markdown: NodeFS.readFileSync(planPath, "utf8"), updatedAt: best.at };
  } catch {
    return null;
  }
};
