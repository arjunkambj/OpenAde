import { makeRequestId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeApprovalGate, type ApprovalGateEvent } from "./approvalGate";
import type { ConnectorPermissions, PermissionDecision } from "./definition";

const threadId = makeThreadId();

const request = (): ApprovalRequest => ({
  requestId: makeRequestId(),
  kind: "command",
  toolName: "Bash",
  input: { command: "rm -rf build" },
  patternSuggestion: "Shell(rm *)",
  description: "Run a shell command",
});

const input = (subject: ApprovalRequest) => ({
  request: subject,
  threadId,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
});

const permissionsSaying = (decision: PermissionDecision): ConnectorPermissions => ({
  decide: () => Effect.succeed(decision),
});

/** A gate over `permissions`, plus every event it emitted. */
const gateWith = (permissions: ConnectorPermissions) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ApprovalGateEvent>>([]);
    const gate = yield* makeApprovalGate({
      permissions,
      emit: (event) => Ref.update(events, (all) => [...all, event]),
    });
    return { gate, events: Ref.get(events) };
  });

/** Waits until `count` events are out — the parked fiber runs concurrently. */
const awaitEvents = (events: Effect.Effect<ReadonlyArray<ApprovalGateEvent>>, count: number) =>
  events.pipe(
    Effect.flatMap((all) => (all.length >= count ? Effect.succeed(all) : Effect.fail("wait"))),
    Effect.eventually,
  );

describe("makeApprovalGate", () => {
  it.effect("returns allow and deny from the rules at once and emits nothing", () =>
    Effect.gen(function* () {
      const allowing = yield* gateWith(permissionsSaying("allow"));
      expect(yield* allowing.gate.decide(input(request()))).toEqual({
        allowed: true,
        via: "rules",
      });
      expect(yield* allowing.events).toEqual([]);

      const denying = yield* gateWith(permissionsSaying("deny"));
      expect(yield* denying.gate.decide(input(request()))).toEqual({
        allowed: false,
        via: "rules",
      });
      expect(yield* denying.events).toEqual([]);
    }),
  );

  it.effect("opens a request on prompt and resolves it with the user's answer", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const subject = request();
      const pending = yield* Effect.forkChild(gate.decide(input(subject)));

      const opened = yield* awaitEvents(events, 1);
      expect(opened).toEqual([
        { type: "request.opened", requestId: subject.requestId, payload: { request: subject } },
      ]);

      // An id the gate never opened changes nothing.
      yield* gate.respond(makeRequestId(), "deny");
      yield* gate.respond(subject.requestId, "allow-always");
      expect(yield* Fiber.join(pending)).toEqual({
        allowed: true,
        decision: "allow-always",
        via: "user",
      });
      expect((yield* events).slice(1)).toEqual([
        {
          type: "request.resolved",
          requestId: subject.requestId,
          payload: { requestId: subject.requestId, decision: "allow-always" },
        },
      ]);
    }),
  );

  it.effect("reads a deny from the card as not allowed", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const subject = request();
      const pending = yield* Effect.forkChild(gate.decide(input(subject)));
      yield* awaitEvents(events, 1);
      yield* gate.respond(subject.requestId, "deny");
      expect(yield* Fiber.join(pending)).toEqual({
        allowed: false,
        decision: "deny",
        via: "user",
      });
    }),
  );

  it.effect("releaseAll answers every open request once", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const first = request();
      const second = request();
      const one = yield* Effect.forkChild(gate.decide(input(first)));
      const two = yield* Effect.forkChild(gate.decide(input(second)));
      yield* awaitEvents(events, 2);

      yield* gate.releaseAll("deny");
      expect((yield* Fiber.join(one)).allowed).toBe(false);
      expect((yield* Fiber.join(two)).allowed).toBe(false);

      const resolved = (yield* events).filter((event) => event.type === "request.resolved");
      expect(resolved.map((event) => event.requestId).sort()).toEqual(
        [first.requestId, second.requestId].sort(),
      );
      expect(
        resolved.every(
          (event) => event.type === "request.resolved" && event.payload.decision === "deny",
        ),
      ).toBe(true);

      // Nothing is left open: a late answer is ignored and emits nothing.
      yield* gate.respond(first.requestId, "allow-once");
      yield* gate.releaseAll("deny");
      expect((yield* events).length).toBe(4);
    }),
  );

  it.effect("asks the user when the permission engine fails, never allows", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith({ decide: () => Effect.die("sqlite is gone") });
      const subject = request();
      const pending = yield* Effect.forkChild(gate.decide(input(subject)));
      const opened = yield* awaitEvents(events, 1);
      expect(opened[0]?.type).toBe("request.opened");
      yield* gate.releaseAll("deny");
      expect(yield* Fiber.join(pending)).toEqual({
        allowed: false,
        decision: "deny",
        via: "user",
      });
    }),
  );
  it.effect("answers deny and resolves the card when the harness withdraws the call", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const subject = request();
      const abort = new AbortController();
      const pending = yield* Effect.forkChild(
        gate.decide({ ...input(subject), signal: abort.signal }),
      );
      yield* awaitEvents(events, 1);

      abort.abort();
      expect(yield* Fiber.join(pending)).toEqual({ allowed: false, decision: "deny", via: "user" });
      expect((yield* events).slice(1)).toEqual([
        {
          type: "request.resolved",
          requestId: subject.requestId,
          payload: { requestId: subject.requestId, decision: "deny" },
        },
      ]);
      // It is no longer open: nothing else can answer it.
      yield* gate.releaseAll("deny");
      expect((yield* events).length).toBe(2);
    }),
  );

  it.effect("resolves at once a call withdrawn before its card was opened", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const subject = request();
      const abort = new AbortController();
      abort.abort();
      expect(yield* gate.decide({ ...input(subject), signal: abort.signal })).toEqual({
        allowed: false,
        decision: "deny",
        via: "user",
      });
      expect((yield* events).map((event) => event.type)).toEqual([
        "request.opened",
        "request.resolved",
      ]);
    }),
  );

  it.effect("keeps the user's answer when the call is withdrawn after it", () =>
    Effect.gen(function* () {
      const { gate, events } = yield* gateWith(permissionsSaying("prompt"));
      const subject = request();
      const abort = new AbortController();
      const pending = yield* Effect.forkChild(
        gate.decide({ ...input(subject), signal: abort.signal }),
      );
      yield* awaitEvents(events, 1);
      yield* gate.respond(subject.requestId, "allow-session");
      expect(yield* Fiber.join(pending)).toEqual({
        allowed: true,
        decision: "allow-session",
        via: "user",
      });
      abort.abort();
      expect((yield* events).map((event) => event.type)).toEqual([
        "request.opened",
        "request.resolved",
      ]);
    }),
  );
});
