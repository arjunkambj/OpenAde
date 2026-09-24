/**
 * Plan mode on Claude Code, as Poseidon runs it.
 *
 * A plan turn puts the CLI in its `plan` permission mode. There the model
 * works read-only, writes its plan to a markdown file of the CLI's own — one
 * per session, directly under `<config dir>/plans/` — and calls ExitPlanMode
 * to hand it over. The CLI reads that file back into the call's input before
 * asking permission for it: `plan` is the file's markdown, `planFilePath` its
 * path. So the plan reaches `canUseTool` whole, and nothing is read off the
 * disk here.
 *
 * Poseidon's side of it:
 *
 * - the ExitPlanMode call is the proposal. `canUseTool` puts the plan on the
 *   timeline and raises the plan card, then denies the call with
 *   `PLAN_CAPTURED`, which tells the model to stop: the turn ends on the
 *   CLI's `result` and the thread waits for the user's answer;
 * - accepting, accepting with auto-accept, or revising is the server's to
 *   carry out: it resets the thread's modes and sends the next turn, whose
 *   mode reaches the CLI through `setPermissionMode` like any other change;
 * - the plan file itself is the one write a plan turn makes. The permission
 *   ladder refuses every write in a plan turn, and would refuse this one too,
 *   and then the CLI would have no plan to hand over. So a write to a
 *   markdown file directly in the CLI's plans directory passes the PreToolUse
 *   hook with no verdict (`isPlanFileWrite`), as ExitPlanMode does, and the
 *   CLI's own plan mode — which lets the model edit its one plan file and
 *   nothing else — decides it. Any other write the CLI asks about still goes
 *   through `canUseTool` to the ladder, which refuses it.
 *
 * A project may move its plans with the CLI's `plansDirectory` setting; those
 * files are not recognised here, their writes are refused as any other write
 * in a plan turn, and ExitPlanMode then arrives with no plan. The model is
 * told so (`NO_PLAN`) rather than a card opening with nothing on it.
 */

import * as NodePath from "node:path";

/** What the model is told once its plan is on the user's card. */
export const PLAN_CAPTURED =
  "Poseidon has shown your plan to the user for approval. Stop here: do not call any more tools and do not restate the plan. The user will accept it or ask for changes in their next message.";

/** What the model is told when ExitPlanMode came with no plan to show. */
export const NO_PLAN =
  "No plan reached Poseidon: ExitPlanMode carried no plan. Write the plan to the plan file named in your plan-mode instructions, then call ExitPlanMode again.";

/** The CLI's plans directory for a child environment: `<config dir>/plans`. */
export const plansDirFor = (env: Readonly<Record<string, string | undefined>>, home: string) =>
  NodePath.join(
    env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_CONFIG_DIR === ""
      ? NodePath.join(env.HOME ?? home, ".claude")
      : env.CLAUDE_CONFIG_DIR,
    "plans",
  );

/** The file tools the model writes its plan with. */
const PLAN_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Whether a call is the model writing its plan file: a file tool on a
 * `.md` file directly in `plansDir`, named by an absolute path. A relative
 * path, one that climbs out with `..`, or one in a subdirectory is not.
 */
export const isPlanFileWrite = (toolName: string, input: unknown, plansDir: string): boolean => {
  if (!PLAN_WRITE_TOOLS.has(toolName)) return false;
  const path = asRecord(input).file_path;
  if (typeof path !== "string" || !NodePath.isAbsolute(path)) return false;
  const resolved = NodePath.resolve(path);
  return (
    NodePath.dirname(resolved) === NodePath.resolve(plansDir) &&
    NodePath.extname(resolved) === ".md"
  );
};

/** The plan an ExitPlanMode call hands over. */
export interface ProposedPlan {
  readonly markdown: string;
  /** The CLI's plan file, which the implementation turn can read back. */
  readonly path?: string;
}

/** The plan in an ExitPlanMode call's input, or undefined when it carries none. */
export const planOf = (input: unknown): ProposedPlan | undefined => {
  const record = asRecord(input);
  const markdown = typeof record.plan === "string" ? record.plan.trim() : "";
  if (markdown === "") return undefined;
  const path = record.planFilePath;
  return typeof path === "string" && path !== "" ? { markdown, path } : { markdown };
};
