import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import { OpenAdeRpcGroup, PROTOCOL_VERSION, RPC_METHODS } from "./rpc";

const STREAMING_METHODS = [
  RPC_METHODS.threadsSubscribe,
  RPC_METHODS.threadsListSubscribe,
  RPC_METHODS.browserSubscribe,
  RPC_METHODS.settingsSubscribe,
];

describe("OpenAdeRpcGroup", () => {
  it.effect("implements exactly the methods RPC_METHODS names", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed([...OpenAdeRpcGroup.requests.keys()].sort());
      expect(tags).toEqual(Object.values(RPC_METHODS).sort());
    }),
  );

  it.effect("streams the four subscriptions and nothing else", () =>
    Effect.gen(function* () {
      const streaming = yield* Effect.succeed(
        [...OpenAdeRpcGroup.requests.values()]
          .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
          .map((rpc) => rpc._tag)
          .sort(),
      );
      expect(streaming).toEqual([...STREAMING_METHODS].sort());
    }),
  );

  it.effect("gives every method a payload schema, so nothing is untyped on the wire", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.succeed(
        [...OpenAdeRpcGroup.requests.values()]
          .filter((rpc) => rpc.payloadSchema === undefined)
          .map((rpc) => rpc._tag),
      );
      expect(missing).toEqual([]);
    }),
  );
});

describe("PROTOCOL_VERSION", () => {
  it.effect("is a positive integer a client can compare against", () =>
    Effect.gen(function* () {
      const version = yield* Effect.succeed(PROTOCOL_VERSION);
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThan(0);
    }),
  );
});
