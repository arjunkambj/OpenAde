import { makeCommandId } from "@OpenAde/contracts/ids";
import type { CommandId } from "@OpenAde/contracts/ids";
import type { CommandReceipt } from "@OpenAde/contracts/orchestration";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { awaitReceiptFrom, collectUntil, makeReceiptRecorder } from "./receipts";

const receipt = (commandId: CommandId, lastSequence: number): CommandReceipt => ({
  commandId,
  status: "accepted",
  lastSequence,
});

describe("makeReceiptRecorder", () => {
  it.effect("returns a receipt that was already recorded", () =>
    Effect.gen(function* () {
      const recorder = yield* makeReceiptRecorder;
      const commandId = makeCommandId();

      yield* recorder.record(receipt(commandId, 7));

      const found = yield* recorder.awaitReceipt(commandId);
      expect(found.lastSequence).toBe(7);
    }),
  );

  it.effect("waits for a receipt that has not arrived yet", () =>
    Effect.gen(function* () {
      const recorder = yield* makeReceiptRecorder;
      const first = makeCommandId();
      const second = makeCommandId();

      // The wait is registered before the receipt exists; the record wakes it.
      const waiting = yield* Effect.forkScoped(recorder.awaitReceipt(second));
      yield* recorder.record(receipt(first, 1));
      yield* recorder.record(receipt(second, 2));

      const found = yield* Fiber.join(waiting);
      expect(found.lastSequence).toBe(2);
      expect((yield* recorder.recorded).map((entry) => entry.lastSequence)).toEqual([1, 2]);
    }),
  );

  it.effect("fails instead of hanging when the recorder is closed first", () =>
    Effect.gen(function* () {
      const recorder = yield* makeReceiptRecorder;
      yield* recorder.record(receipt(makeCommandId(), 1));
      yield* recorder.close;

      const error = yield* recorder.awaitReceipt(makeCommandId()).pipe(Effect.flip);
      expect(error._tag).toBe("StreamEnded");
      expect(error.seen).toBe(1);
    }),
  );
});

describe("awaitReceiptFrom", () => {
  it.effect("picks its receipt out of a stream of them", () =>
    Effect.gen(function* () {
      const wanted = makeCommandId();
      const receipts = Stream.fromIterable([
        receipt(makeCommandId(), 1),
        receipt(wanted, 2),
        receipt(makeCommandId(), 3),
      ]);

      const found = yield* awaitReceiptFrom(receipts, wanted);
      expect(found.lastSequence).toBe(2);
    }),
  );
});

describe("collectUntil", () => {
  it.effect("stops at the first matching item and keeps it", () =>
    Effect.gen(function* () {
      const collected = yield* collectUntil(Stream.fromIterable([1, 2, 3, 4]), (n) => n === 3);
      expect(collected).toEqual([1, 2, 3]);
    }),
  );
});
