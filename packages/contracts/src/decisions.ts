/**
 * The record a thread keeps of every approval, question and plan the user
 * settled. The thread read models in `orchestration.ts` carry it: the
 * sidebar's summary says which kind a thread waits on, and the detail
 * snapshot lists every settled one for the timeline.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString } from "./base";
import { ItemId } from "./ids";

/** The three things a thread can stop and ask the user about. */
export const DecisionKind = Schema.Literals(["approval", "question", "plan"]);
export type DecisionKind = typeof DecisionKind.Type;

/**
 * The outcome of an approval or question the runtime settled on its own: the
 * harness process exited (Stop, a crash, an archive) while the card was still
 * open, and the connector released the parked request so the hook could
 * reply. The user never chose, so the record must not say they did.
 */
export const UNANSWERED_OUTCOME = "unanswered";

/**
 * One settled approval, question or plan, as the timeline records it after
 * the card is gone. `id` is the request id, or the turn id for a plan;
 * `outcome` is the `ApprovalDecision` or `PlanResponseAction` chosen,
 * `"answered"` for a question, or `UNANSWERED_OUTCOME` when the runtime
 * settled the request without the user. `subject` is a one-line reminder of
 * what was asked — the approval's target (else its tool), the first
 * question's header (else its text), the plan file's name. `afterItemId` is
 * the last timeline item when the answer landed, so a client can place the
 * record in order.
 */
export const ResolvedDecision = Schema.Struct({
  kind: DecisionKind,
  id: NonEmptyString,
  outcome: Schema.String,
  subject: Schema.optional(Schema.String),
  pattern: Schema.optional(NonEmptyString),
  resolvedAt: IsoDateTime,
  afterItemId: Schema.optional(ItemId),
});
export type ResolvedDecision = typeof ResolvedDecision.Type;
