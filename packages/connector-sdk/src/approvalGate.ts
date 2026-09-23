/**
 * The approval flow, for a connector that asks rather than being asked.
 *
 * A harness gates its tool calls one of two ways. One with shell hooks runs a
 * script per call, and the script posts to the server's hook bridge — the
 * connector answers that post. One driven over an SDK or JSON-RPC asks its
 * host directly: a permission callback, an approval request on the wire. Both
 * end in the same place: the permission ladder decides, and when it says
 * "prompt" the user does, through a card.
 *
 * This is that shared end. `decide` asks `services.permissions`; allow and
 * deny return at once and emit nothing, while prompt emits `request.opened`,
 * parks until `respond` (the session handle's `respondToRequest`) answers, and
 * emits `request.resolved`. `releaseAll` answers every parked request — the
 * process that asked is gone — so nothing waits on a card nobody can see.
 *
 * A defect inside `permissions.decide` is answered as a prompt: a permissions
 * failure must never read as allow, and asking costs the user a click.
 */

import type { ApprovalDecision, InteractionMode, RuntimeMode } from "@OpenAde/contracts/enums";
import type { RequestId, ThreadId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ConnectorPermissions, PermissionDecision } from "./definition";

/** What the gate emits — both are ordinary `RuntimeEvent`s minus the envelope. */
export type ApprovalGateEvent =
  | {
      readonly type: "request.opened";
      readonly requestId: RequestId;
      readonly payload: { readonly request: ApprovalRequest };
    }
  | {
      readonly type: "request.resolved";
      readonly requestId: RequestId;
      readonly payload: { readonly requestId: RequestId; readonly decision: ApprovalDecision };
    };

/** One tool call to decide, with the thread's live modes. */
export interface ApprovalGateInput {
  readonly request: ApprovalRequest;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
}

/**
 * The answer for one tool call. `via: "rules"` is the ladder deciding on its
 * own; `via: "user"` carries the card's `decision`.
 */
export interface ApprovalVerdict {
  readonly allowed: boolean;
  readonly decision?: ApprovalDecision;
  readonly via: "rules" | "user";
}

export interface ApprovalGate {
  readonly decide: (input: ApprovalGateInput) => Effect.Effect<ApprovalVerdict>;
  /** The user's answer to an open request; an unknown id is ignored. */
  readonly respond: (requestId: RequestId, decision: ApprovalDecision) => Effect.Effect<void>;
  /** Answers every open request with `decision` and emits its `request.resolved`. */
  readonly releaseAll: (decision: ApprovalDecision) => Effect.Effect<void>;
}

type OpenRequests = ReadonlyMap<RequestId, Deferred.Deferred<ApprovalDecision>>;

export const makeApprovalGate = (options: {
  readonly permissions: ConnectorPermissions;
  readonly emit: (event: ApprovalGateEvent) => Effect.Effect<void>;
}): Effect.Effect<ApprovalGate> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<OpenRequests>(new Map());

    const resolved = (requestId: RequestId, decision: ApprovalDecision) =>
      options.emit({ type: "request.resolved", requestId, payload: { requestId, decision } });

    /** Takes a request out of the open set; true when it was still there. */
    const take = (requestId: RequestId) =>
      Ref.modify(pending, (map) => {
        if (!map.has(requestId)) return [false, map] as const;
        const next = new Map(map);
        next.delete(requestId);
        return [true, next] as const;
      });

    const ask = (request: ApprovalRequest): Effect.Effect<ApprovalVerdict> =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<ApprovalDecision>();
        yield* Ref.update(pending, (map) => new Map(map).set(request.requestId, released));
        yield* options.emit({
          type: "request.opened",
          requestId: request.requestId,
          payload: { request },
        });
        const decision = yield* Deferred.await(released);
        // `releaseAll` already took it out and said so; only `respond` leaves
        // the resolution to be announced here.
        if (yield* take(request.requestId)) {
          yield* resolved(request.requestId, decision);
        }
        return { allowed: decision !== "deny", decision, via: "user" };
      });

    return {
      decide: (input) =>
        options.permissions.decide(input).pipe(
          Effect.catchDefect(() => Effect.succeed<PermissionDecision>("prompt")),
          Effect.flatMap((verdict): Effect.Effect<ApprovalVerdict> =>
            verdict === "prompt"
              ? ask(input.request)
              : Effect.succeed({ allowed: verdict === "allow", via: "rules" }),
          ),
        ),
      respond: (requestId, decision) =>
        Effect.gen(function* () {
          const released = (yield* Ref.get(pending)).get(requestId);
          if (released === undefined) return;
          yield* Deferred.succeed(released, decision);
        }),
      releaseAll: (decision) =>
        Effect.gen(function* () {
          const open = yield* Ref.getAndSet(pending, new Map() as OpenRequests);
          for (const [requestId, released] of open) {
            yield* Deferred.succeed(released, decision);
            // An answer that landed first stands; announce whichever won.
            const answer = yield* Deferred.await(released);
            yield* resolved(requestId, answer);
          }
        }),
    };
  });
