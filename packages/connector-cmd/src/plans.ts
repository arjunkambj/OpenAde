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

import type { ItemId, TurnId } from "@OpenAde/contracts/ids";

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
const WRITE_TOOLS = new Set(["write_file", "create_file", "edit_file"]);

/** The plan file a `write_file` input names, or null for an ordinary edit. */
const planFileIn = (toolName: unknown, input: unknown): string | null => {
  if (typeof toolName !== "string" || !WRITE_TOOLS.has(toolName)) {
    return null;
  }
  const record = (input ?? {}) as Record<string, unknown>;
  const raw = record["file_path"] ?? record["path"];
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

/**
 * True when a tool call is the model writing its plan.
 *
 * A plan turn runs without `--yolo` — that is the only thing standing between
 * the model and the workspace in a mode the UI presents as read-only — so
 * print mode refuses this write like any other. The refusal is not a failure
 * the user needs to see: the content was in the frame that announced the call
 * and OpenAde saves the file itself.
 */
export const isPlanWrite = (toolName: unknown, input: unknown): boolean =>
  planFileIn(toolName, input) !== null;

/** What the timeline shows instead of the harness's refusal. */
export const PLAN_SAVED = "plan saved";

export interface PlanWrite {
  readonly file: string;
  readonly content: string;
}

/**
 * The plan a stdout frame says this turn wrote — name and content both.
 *
 * Print mode writes the plan with an ordinary `write_file`, and the
 * `tool_queued` frame that announces the call carries its path *and* its whole
 * body. Only the base name is taken: the plans directory is fixed, and the
 * recordings replace the operator's home with a placeholder, so an absolute
 * path from a frame is not one this process can open. A write whose parent
 * directory is not `plans` is an ordinary workspace edit and is ignored.
 */
export const planWriteIn = (frame: unknown): PlanWrite | null => {
  const event = (frame as { readonly event?: Record<string, unknown> } | null)?.event;
  if (event === undefined || event["type"] !== "tool_queued") {
    return null;
  }
  const input = event["input"];
  const file = planFileIn(event["toolName"], input);
  if (file === null) {
    return null;
  }
  const content = ((input ?? {}) as Record<string, unknown>)["content"];
  return { file, content: typeof content === "string" ? content : "" };
};

/**
 * Writes a plan the harness refused to write.
 *
 * Without `--yolo` print mode declines the plan file along with every other
 * write (`fixtures/cmd/plan-no-yolo/`), which is exactly what makes plan mode
 * read-only — and the plan is not lost by it, because the `tool_queued` frame
 * already carried the whole body. Content is only written when there is some:
 * an empty body would replace a plan the harness did manage to write.
 */
export const materializePlan = (write: PlanWrite, home?: string): void => {
  if (write.content === "") {
    return;
  }
  try {
    const dir = plansDirFor(home);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, write.file), write.content, "utf8");
  } catch {
    // Nothing to propose then; `readPlanProposal` answers null and the turn
    // settles without a plan card, which is a normal outcome.
  }
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
/**
 * What a settled plan turn puts on the wire: a timeline row and a card.
 *
 * They are two surfaces and a plan needs both. `turn.plan.proposed` raises the
 * card the user answers, and that card clears the moment they do — so the
 * plan, the most consequential thing in a plan-mode thread, used to leave no
 * trace at all. Scrolling back through a finished thread showed an
 * implementation turn citing a file path and nothing that said what had been
 * agreed. `plan` is one of the fifteen ItemKinds and the renderer has had a
 * row for it all along; nothing had ever produced one.
 *
 * The turn id is minted by the caller's `makeTurnId`; the engine overwrites it
 * with its own (02 · N3), so what matters here is that both events name the
 * same proposal.
 */
export const planProposalEvents = (
  proposal: PlanProposal,
  ids: { readonly itemId: ItemId; readonly turnId: TurnId },
): ReadonlyArray<
  | {
      readonly type: "item.completed";
      readonly payload: {
        readonly item: {
          readonly itemId: ItemId;
          readonly kind: "plan";
          readonly status: "completed";
          readonly text: string;
        };
      };
    }
  | {
      readonly type: "turn.plan.proposed";
      readonly payload: {
        readonly turnId: TurnId;
        readonly planMarkdown: string;
        readonly planPath: string;
      };
    }
> => [
  {
    type: "item.completed",
    payload: {
      item: {
        itemId: ids.itemId,
        kind: "plan",
        status: "completed",
        text: proposal.markdown,
      },
    },
  },
  {
    type: "turn.plan.proposed",
    payload: {
      turnId: ids.turnId,
      planMarkdown: proposal.markdown,
      planPath: proposal.planPath,
    },
  },
];

/**
 * The events a settled plan turn owes the timeline, or none.
 *
 * `seen` is the session's own set of `<path>#<revision>` keys, mutated here: a
 * plan already proposed is not proposed again, while a revised plan file is.
 * Keeping this beside the reading of the plan is what lets the session stay a
 * description of process mechanics.
 */
export const planProposalFor = (input: {
  readonly plan: boolean;
  readonly sessionId: string | null;
  readonly home?: string | undefined;
  readonly startedAt: number;
  readonly wrote: ReadonlyArray<string>;
  readonly seen: Set<string>;
  readonly ids: () => { readonly itemId: ItemId; readonly turnId: TurnId };
}): ReadonlyArray<ReturnType<typeof planProposalEvents>[number]> => {
  if (!input.plan || input.sessionId === null) {
    return [];
  }
  const proposal = readPlanProposal(input.sessionId, input.home, input.startedAt, input.wrote);
  if (proposal === null) {
    return [];
  }
  const key = `${proposal.planPath}#${proposal.updatedAt}`;
  if (input.seen.has(key)) {
    return [];
  }
  input.seen.add(key);
  return planProposalEvents(proposal, input.ids());
};

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
