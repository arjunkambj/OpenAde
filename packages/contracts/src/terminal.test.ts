import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeTerminalId, makeThreadId } from "./ids";
import { OpenAdeRpcGroup, RPC_METHODS } from "./rpc";
import {
  TERMINAL_BATCH_CHARS,
  TERMINAL_BATCH_MS,
  TERMINAL_SCROLLBACK_CHARS,
  TERMINAL_STREAM_BUDGET_BYTES,
  TERMINAL_STREAM_BUDGET_ITEMS,
  TERMINAL_WRITE_MAX_CHARS,
  TERMINALS_PER_THREAD,
  TerminalSize,
} from "./terminal";

describe("TerminalSize", () => {
  it.effect("accepts a grid inside the bounds and refuses one outside them", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownExit(TerminalSize);
      for (const size of [
        { cols: 2, rows: 1 },
        { cols: 120, rows: 32 },
        { cols: 1000, rows: 500 },
      ]) {
        expect((yield* Effect.sync(() => decode(size)))._tag).toBe("Success");
      }
      for (const size of [
        { cols: 1, rows: 24 },
        { cols: 80, rows: 0 },
        { cols: 1001, rows: 24 },
        { cols: 80, rows: 501 },
        { cols: 80.5, rows: 24 },
      ]) {
        expect((yield* Effect.sync(() => decode(size)))._tag).toBe("Failure");
      }
    }),
  );
});

describe("terminal.write", () => {
  it.effect("refuses a payload longer than the write limit", () =>
    Effect.gen(function* () {
      const rpc = OpenAdeRpcGroup.requests.get(RPC_METHODS.terminalWrite);
      expect(rpc).toBeDefined();
      const decode = Schema.decodeUnknownExit(rpc!.payloadSchema as Schema.Codec<unknown>);
      const ids = { threadId: makeThreadId(), terminalId: makeTerminalId() };
      const fits = yield* Effect.sync(() =>
        decode({ ...ids, data: "x".repeat(TERMINAL_WRITE_MAX_CHARS) }),
      );
      expect(fits._tag).toBe("Success");
      const tooLong = yield* Effect.sync(() =>
        decode({ ...ids, data: "x".repeat(TERMINAL_WRITE_MAX_CHARS + 1) }),
      );
      expect(tooLong._tag).toBe("Failure");
    }),
  );
});

describe("the terminal limits", () => {
  it.effect("are the ones the contract names, so server and client cannot drift", () =>
    Effect.gen(function* () {
      const limits = yield* Effect.succeed({
        scrollbackChars: TERMINAL_SCROLLBACK_CHARS,
        batchMs: TERMINAL_BATCH_MS,
        batchChars: TERMINAL_BATCH_CHARS,
        streamBytes: TERMINAL_STREAM_BUDGET_BYTES,
        streamItems: TERMINAL_STREAM_BUDGET_ITEMS,
        perThread: TERMINALS_PER_THREAD,
        writeChars: TERMINAL_WRITE_MAX_CHARS,
      });
      expect(limits).toEqual({
        scrollbackChars: 1_048_576,
        batchMs: 16,
        batchChars: 65_536,
        streamBytes: 4_194_304,
        streamItems: 4096,
        perThread: 8,
        writeChars: 1_048_576,
      });
    }),
  );

  it.effect("keep one output batch well inside the scrollback", () =>
    Effect.gen(function* () {
      const limits = yield* Effect.succeed({
        batch: TERMINAL_BATCH_CHARS,
        scrollback: TERMINAL_SCROLLBACK_CHARS,
      });
      expect(limits.batch).toBeLessThan(limits.scrollback);
    }),
  );
});
