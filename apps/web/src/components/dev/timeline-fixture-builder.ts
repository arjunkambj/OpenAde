/**
 * The machinery behind the timeline fixture's "Conversation" scenario: a clock
 * that mints UUIDv7 ids as it moves, and a builder that appends items,
 * decision records and checkpoints the way the server would record them.
 * `timeline-fixture-data.ts` writes the turns with it.
 */

import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import {
  decodeCheckpointId,
  decodeItemId,
  decodeTurnId,
  type ItemId,
  type TurnId,
} from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

export const WORKSPACE_ROOT = "/fixture";

/** A UUIDv7 at `millis`: the sequence number fills the counter and node fields. */
const uuidAt = (millis: number, sequence: number): string => {
  const stamp = millis.toString(16).padStart(12, "0");
  const counter = (sequence & 0xfff).toString(16).padStart(3, "0");
  const node = sequence.toString(16).padStart(15, "0");
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${counter}-8${node.slice(0, 3)}-${node.slice(3)}`;
};

export type ItemFields = Omit<ItemSnapshot, "itemId" | "turnId">;

export interface Builder {
  readonly threadId: string;
  /** Move the clock forward, then mint an id there. */
  readonly mint: (afterMs: number) => string;
  /** Move the clock to `millis` unless it is already past it. */
  readonly jumpTo: (millis: number) => void;
  readonly iso: () => string;
  /** Append an item to `turnId`, `afterMs` after the previous one. */
  readonly add: (turnId: TurnId, afterMs: number, fields: ItemFields) => ItemId;
  readonly decide: (
    decision: Omit<ResolvedDecision, "resolvedAt" | "id"> & { id?: string },
  ) => void;
  /** Settle a turn as the server does, with its checkpoint unless `checkpoint` is false. */
  readonly settle: (turnId: TurnId, checkpoint: boolean) => void;
  readonly items: ItemSnapshot[];
  readonly decisions: ResolvedDecision[];
  readonly checkpoints: CheckpointSummary[];
}

export const makeBuilder = (start: number): Builder => {
  let clock = start;
  let sequence = 0;
  const mint = (afterMs: number): string => {
    clock += Math.max(1, afterMs);
    sequence += 1;
    return uuidAt(clock, sequence);
  };
  const threadId = mint(0);
  const builder: Builder = {
    threadId,
    mint,
    jumpTo: (millis) => {
      clock = Math.max(clock, millis);
    },
    iso: () => new Date(clock).toISOString(),
    add: (turnId, afterMs, fields) => {
      const itemId = decodeItemId(mint(afterMs));
      builder.items.push({ ...fields, itemId, turnId } as ItemSnapshot);
      return itemId;
    },
    decide: (decision) => {
      const id = decision.id ?? mint(0);
      builder.decisions.push({ ...decision, id, resolvedAt: builder.iso() });
    },
    settle: (turnId, checkpoint) => {
      if (!checkpoint) return;
      const checkpointId = decodeCheckpointId(mint(1_000));
      builder.checkpoints.push({
        checkpointId,
        turnId,
        ref: `refs/poseidon/checkpoints/${threadId}/${turnId}`,
        createdAt: builder.iso(),
      });
    },
    items: [],
    decisions: [],
    checkpoints: [],
  };
  return builder;
};

export const turn = (b: Builder, afterMs: number): TurnId => decodeTurnId(b.mint(afterMs));

export const done = "completed" as const;

export const say = (value: string): ItemFields => ({
  kind: "assistant_message",
  status: done,
  text: value,
});

export const tool = (
  name: string,
  input: Record<string, unknown>,
  output?: unknown,
): ItemFields => ({
  kind: "tool_call",
  status: done,
  tool: { name, input, ...(output === undefined ? {} : { output }) },
});

export const run = (cmd: string, exitCode: number, output: string): ItemFields => ({
  kind: "command_execution",
  status: exitCode === 0 ? done : "failed",
  command: { cmd, cwd: WORKSPACE_ROOT, exitCode, output },
});

export const change = (
  path: string,
  kind: "create" | "edit" | "delete",
  diff: string,
): ItemFields => ({
  kind: "file_change",
  status: done,
  fileChange: { path, kind, diff },
});
