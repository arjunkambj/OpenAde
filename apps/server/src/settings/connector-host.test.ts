/**
 * The host façade is late-bound on purpose: the connector manager opens
 * instances while the layer graph is still being built, long before the hook
 * bridge or the permission ladder exist. These tests pin the two halves of
 * that contract — the safe behaviour before `install`, and that an instance
 * holding the *same* services object sees the real endpoints afterwards.
 */

import { makeRequestId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { ConnectorHost } from "./ConnectorHost";

const request: ApprovalRequest = {
  requestId: makeRequestId(),
  kind: "command",
  toolName: "Bash",
  input: {},
  description: "run something",
};

const host = Effect.map(Layer.build(ConnectorHost.layer), (ctx) => Context.get(ctx, ConnectorHost));

describe("ConnectorHost", () => {
  it.effect("before install an endpoint is a defect and every decision is prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { services } = yield* host;
        const threadId = makeThreadId();

        const hook = yield* Effect.exit(services.hookEndpoint(threadId));
        expect(Exit.isFailure(hook)).toBe(true);
        const mcp = yield* Effect.exit(services.mcpEndpoint(threadId));
        expect(Exit.isFailure(mcp)).toBe(true);

        const decision = yield* services.permissions.decide({
          request,
          threadId,
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(decision).toBe("prompt");
      }),
    ),
  );

  it.effect("an object taken before install answers from the installed endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* host;
        // Exactly what `registry.open` captured at open time.
        const { services } = service;
        const threadId = makeThreadId();

        yield* service.install({
          mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "m" }),
          hookEndpoint: (id) => Effect.succeed({ url: `http://hook/${id}`, bearer: "h" }),
          permissions: { decide: () => Effect.succeed("deny") },
        });

        expect(yield* services.hookEndpoint(threadId)).toEqual({
          url: `http://hook/${threadId}`,
          bearer: "h",
        });
        expect(yield* services.mcpEndpoint(threadId)).toEqual({
          url: `http://mcp/${threadId}`,
          bearer: "m",
        });
        expect(
          yield* services.permissions.decide({
            request,
            threadId,
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ).toBe("deny");
      }),
    ),
  );

  it.effect("registering a hook handler without a bridge is a warning, not a crash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* host;
        const threadId = makeThreadId();
        // The connector branches on `undefined`, so the member must exist.
        expect(service.services.registerHookHandler).toBeDefined();
        yield* service.services.registerHookHandler!(threadId, () => Effect.succeed({}));
        yield* service.services.unregisterHookHandler!(threadId);
      }),
    ),
  );
});
