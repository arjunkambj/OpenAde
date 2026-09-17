/**
 * Reading the plan a plan-mode turn leaves behind (spec sections 5.6 and 8).
 *
 * `--permission-mode plan` makes the harness write
 * `~/.commandcode/plans/<name>.md` and record it in `plans-index.json` beside
 * it: `{ version, plans: { <file>: { title, sessionId, cwd, status,
 * createdAt, updatedAt, annotations[] } } }`. The index entry's `sessionId`
 * is how a finished turn finds its plan — the file name alone says nothing
 * about which session wrote it. A plan-mode turn that produced no plan is a
 * normal outcome, so every failure here resolves to "nothing proposed".
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

/**
 * The newest index entry recorded against `sessionId`, with its markdown —
 * or null when the index is absent/corrupt or the file is unreadable.
 */
export const readPlanProposal = (sessionId: string, home?: string): PlanProposal | null => {
  const dir = plansDirFor(home);
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
  let best: { readonly file: string; readonly at: number } | null = null;
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
  if (best === null) {
    return null;
  }
  const planPath = NodePath.join(dir, best.file);
  try {
    return { planPath, markdown: NodeFS.readFileSync(planPath, "utf8"), updatedAt: best.at };
  } catch {
    return null;
  }
};
