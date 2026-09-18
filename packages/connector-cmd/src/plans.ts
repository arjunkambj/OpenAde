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
 * So the index is consulted first, and after it the file the turn's own frames
 * name. The plan is written by an ordinary `write_file`, whose `tool_queued`
 * frame carries the path — the one identifier that ties a plan file to the run
 * that produced it (`planFileNameIn`).
 *
 * Only when neither answers does an mtime scan run: the newest `.md` in the
 * plans directory written at or after the moment the turn was spawned. That
 * scan is a guess and it has to be fenced, because the plans directory is
 * global — every thread of every project writes into it, and so do the user's
 * own interactive `cmd` sessions. Two plan turns overlapping in time would
 * otherwise both resolve to whichever file is newest, and a thread would
 * propose, and the user accept, a plan belonging to another conversation. So
 * the scan skips any file another live session has already claimed.
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
 * The plan file a stdout frame says this turn wrote, or null.
 *
 * Print mode writes the plan with an ordinary `write_file` and the
 * `tool_queued` frame that announces the call carries its path. Only the base
 * name is taken: the plans directory is fixed, and the recordings replace the
 * operator's home with a placeholder, so an absolute path from a frame is not
 * one this process can open. A write whose parent directory is not `plans` is
 * an ordinary workspace edit and is ignored.
 */
export const planFileNameIn = (frame: unknown): string | null => {
  const event = (frame as { readonly event?: Record<string, unknown> } | null)?.event;
  if (event === undefined || event["type"] !== "tool_queued") {
    return null;
  }
  const tool = event["toolName"];
  if (tool !== "write_file" && tool !== "create_file" && tool !== "edit_file") {
    return null;
  }
  const input = event["input"] as Record<string, unknown> | undefined;
  const raw = input?.["file_path"] ?? input?.["path"];
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const normalized = raw.replaceAll("\\", "/");
  if (NodePath.posix.basename(NodePath.posix.dirname(normalized)) !== "plans") {
    return null;
  }
  const file = NodePath.posix.basename(normalized);
  return file.endsWith(".md") ? file : null;
};

/** The newest of the files this turn's own frames named, if any still exists. */
const fromWrites = (
  files: ReadonlyArray<string>,
  home?: string,
): { file: string; at: number } | null => {
  let best: { file: string; at: number } | null = null;
  for (const file of files) {
    let at: number;
    try {
      at = NodeFS.statSync(NodePath.join(plansDirFor(home), file)).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || at >= best.at) {
      best = { file, at };
    }
  }
  return best;
};

/**
 * Plan files a live session has already proposed, and which session proposed
 * them. Only the mtime scan consults this — a plan found by the index or by the
 * turn's own frames belongs to that turn whatever anyone else is showing.
 */
const claimedPlans = new Map<string, string>();

/** Drops a closing session's claims, so the next run may scan those files again. */
export const releasePlanClaims = (sessionId: string): void => {
  for (const [file, owner] of claimedPlans) {
    if (owner === sessionId) {
      claimedPlans.delete(file);
    }
  }
};

/**
 * The newest plan markdown written at or after `since` — the last-resort
 * fallback, because print mode leaves `plans-index.json` alone and a model that
 * wrote its plan some other way leaves no frame naming it. A one-second
 * allowance absorbs the gap between our clock and the file system's.
 */
const MTIME_SLACK_MS = 1000;

const writtenThisTurn = (
  since: number,
  sessionId: string,
  home?: string,
): { file: string; at: number } | null => {
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
    // Another live session is already showing this one. Guessing by mtime is
    // how two concurrent plan turns end up proposing each other's plan.
    const owner = claimedPlans.get(NodePath.join(plansDirFor(home), entry.name));
    if (owner !== undefined && owner !== sessionId) {
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
 * there is none.
 *
 * `wrote` is the plan files the turn's own `write_file` frames named, and it is
 * what makes the answer this run's rather than whatever the directory happened
 * to hold. `since` is when the turn was spawned, and drives the mtime scan of
 * last resort; without either, only the index is consulted, which in print mode
 * means nothing is ever found.
 */
export const readPlanProposal = (
  sessionId: string,
  home?: string,
  since?: number,
  wrote: ReadonlyArray<string> = [],
): PlanProposal | null => {
  const best =
    fromIndex(sessionId, home) ??
    fromWrites(wrote, home) ??
    (since === undefined ? null : writtenThisTurn(since, sessionId, home));
  if (best === null) {
    return null;
  }
  const planPath = NodePath.join(plansDirFor(home), best.file);
  try {
    const markdown = NodeFS.readFileSync(planPath, "utf8");
    claimedPlans.set(planPath, sessionId);
    return { planPath, markdown, updatedAt: best.at };
  } catch {
    return null;
  }
};
