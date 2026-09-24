import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import {
  DEV_SERVER_LIMIT,
  DevServer,
  FS_BROWSE_ENTRY_LIMIT,
  FsBrowseFailure,
  OpenAdeRpcGroup,
  PROTOCOL_VERSION,
  RPC_METHODS,
  STREAM_BUDGET_BYTES,
  STREAM_BUDGET_ITEMS,
  STREAM_COALESCE_MS,
} from "./rpc";

const STREAMING_METHODS = [
  RPC_METHODS.threadsSubscribe,
  RPC_METHODS.threadsListSubscribe,
  RPC_METHODS.browserSubscribe,
  RPC_METHODS.settingsSubscribe,
  RPC_METHODS.gitWorktreeSetup,
  RPC_METHODS.terminalSubscribe,
];

describe("OpenAdeRpcGroup", () => {
  it.effect("implements exactly the methods RPC_METHODS names", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed([...OpenAdeRpcGroup.requests.keys()].sort());
      expect(tags).toEqual(Object.values(RPC_METHODS).sort());
    }),
  );

  it.effect("streams the five subscriptions and the setup script, and nothing else", () =>
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

describe("fs.browse", () => {
  it.effect("caps a listing, so one directory can never be an unbounded frame", () =>
    Effect.gen(function* () {
      const limit = yield* Effect.succeed(FS_BROWSE_ENTRY_LIMIT);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }),
  );

  it.effect("names every failure the picker has a different answer for", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.succeed([...FsBrowseFailure.literals].sort());
      expect(reasons).toEqual([
        "internal",
        "not-a-directory",
        "not-absolute",
        "not-found",
        "permission-denied",
      ]);
    }),
  );
});

describe("browser.discoverServers", () => {
  const rpc = OpenAdeRpcGroup.requests.get(RPC_METHODS.browserDiscoverServers);
  const decode = Schema.decodeUnknownExit(DevServer);

  it("is a plain request keyed by the thread, answering a list of servers", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    const payload = Schema.decodeUnknownExit(rpc!.payloadSchema)({
      threadId: "0190aaaa-0000-7000-8000-000000000001",
    });
    expect(payload._tag).toBe("Success");
    const answer = Schema.decodeUnknownExit(rpc!.successSchema)([
      { url: "http://localhost:5173", port: 5173, processName: "node" },
      { url: "http://localhost:3000", port: 3000, processName: null },
    ]);
    expect(answer._tag).toBe("Success");
  });

  it("carries a port a socket can have, and a name only when there is one", () => {
    const server = { url: "http://localhost:5173", port: 5173, processName: "node" };
    expect(decode(server)._tag).toBe("Success");
    expect(decode({ ...server, port: 0 })._tag).toBe("Failure");
    expect(decode({ ...server, port: 65536 })._tag).toBe("Failure");
    expect(decode({ ...server, port: 51.5 })._tag).toBe("Failure");
    expect(decode({ ...server, processName: "" })._tag).toBe("Failure");
    expect(decode({ ...server, url: "" })._tag).toBe("Failure");
    expect(Number.isInteger(DEV_SERVER_LIMIT) && DEV_SERVER_LIMIT > 0).toBe(true);
  });
});

describe("the stream budget", () => {
  it.effect("is the one the contract names, so server and client cannot drift", () =>
    Effect.gen(function* () {
      const budget = yield* Effect.succeed({
        items: STREAM_BUDGET_ITEMS,
        bytes: STREAM_BUDGET_BYTES,
        coalesceMs: STREAM_COALESCE_MS,
      });
      expect(budget).toEqual({ items: 1000, bytes: 8_388_608, coalesceMs: 50 });
    }),
  );
});
