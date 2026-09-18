import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeLiveBuffer } from "./LiveBuffer";

interface TestItem {
  readonly key: string;
  readonly value: string;
}

const WINDOW = Duration.millis(50);

const makeBuffer = Effect.gen(function* () {
  const buffer = yield* makeLiveBuffer<TestItem>({
    window: WINDOW,
    sizeOf: () => 1,
    mergeKeyOf: (item) => item.key,
    overflowItem: (reason) => ({ key: "overflow", value: reason }),
  });
  const seen = yield* Queue.unbounded<TestItem>();
  yield* buffer.stream.pipe(
    Stream.runForEach((item) => Queue.offer(seen, item)),
    Effect.forkChild,
  );
  return { buffer, seen };
});

/**
 * Waits for `seen` to reach `count`, giving scheduled work a few turns to
 * drain the flush chain (timer → mutex → output → consumer). A flush that
 * never happens returns `false` instead of hanging the test.
 */
const drainTo = (seen: Queue.Dequeue<TestItem>, count: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let i = 0; i < 20; i++) {
      if ((yield* Queue.size(seen)) >= count) {
        return true;
      }
      yield* Effect.yieldNow;
    }
    return false;
  });

describe("LiveBuffer", () => {
  it.effect("re-arms the coalescing window after every flush", () =>
    Effect.gen(function* () {
      const { buffer, seen } = yield* makeBuffer;

      // First window: the offer arms a timer, the adjust fires the flush.
      yield* buffer.offer({ key: "a", value: "first" });
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 1)).toBe(true);

      // Second window: the fired timer must have cleared `timerRef`, or this
      // mergeable offer parks in pendingRef and nothing ever flushes it.
      yield* buffer.offer({ key: "b", value: "second" });
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 2)).toBe(true);

      expect((yield* Queue.take(seen)).value).toBe("first");
      expect((yield* Queue.take(seen)).value).toBe("second");
    }),
  );

  it.effect("coalesces same-key items inside one window", () =>
    Effect.gen(function* () {
      const { buffer, seen } = yield* makeBuffer;

      yield* buffer.offer({ key: "a", value: "v1" });
      yield* buffer.offer({ key: "a", value: "v2" });
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 1)).toBe(true);
      // One window, one merged item — the latest wins.
      expect((yield* Queue.take(seen)).value).toBe("v2");
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 1)).toBe(false);
    }),
  );

  it.effect("flushes a window in arrival order, merges included", () =>
    Effect.gen(function* () {
      const { buffer, seen } = yield* makeBuffer;

      // Two keys, interleaved, with the *first* key written last. Replacing a
      // merged item in place left it standing at its first arrival's slot, so
      // this window flushed `a` before `b` even though `a`'s surviving version
      // arrived after `b`'s.
      //
      // For a thread subscription the positions are event sequences and the
      // client ignores an event that does not arrive in increasing order, so
      // the out-of-order one was dropped: an assistant row written either side
      // of a usage frame never reached the timeline.
      yield* buffer.offer({ key: "a", value: "a1" });
      yield* buffer.offer({ key: "b", value: "b1" });
      yield* buffer.offer({ key: "a", value: "a2" });
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 2)).toBe(true);

      expect((yield* Queue.take(seen)).value).toBe("b1");
      expect((yield* Queue.take(seen)).value).toBe("a2");
    }),
  );

  it.effect("keeps merging a key it has already moved to the end", () =>
    Effect.gen(function* () {
      const { buffer, seen } = yield* makeBuffer;

      // Moving a merged item re-indexes the whole window, so the third write
      // to `a` has to find `a` where the second write left it. A stale index
      // here would overwrite `b` — or append a duplicate row.
      yield* buffer.offer({ key: "a", value: "a1" });
      yield* buffer.offer({ key: "b", value: "b1" });
      yield* buffer.offer({ key: "a", value: "a2" });
      yield* buffer.offer({ key: "b", value: "b2" });
      yield* buffer.offer({ key: "a", value: "a3" });
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 2)).toBe(true);

      expect((yield* Queue.take(seen)).value).toBe("b2");
      expect((yield* Queue.take(seen)).value).toBe("a3");
      // Two keys in, two rows out: nothing was duplicated by the re-indexing.
      yield* TestClock.adjust(Duration.millis(60));
      expect(yield* drainTo(seen, 1)).toBe(false);
    }),
  );
});
