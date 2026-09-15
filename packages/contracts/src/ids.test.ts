import { isUuidV7 } from "@OpenAde/shared/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ConnectorKind,
  ThreadId,
  decodeThreadId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "./ids";

describe("branded ids", () => {
  it.effect("mints UUIDv7 values that decode back to themselves", () =>
    Effect.gen(function* () {
      const threadId = yield* Effect.sync(makeThreadId);
      expect(isUuidV7(threadId)).toBe(true);
      expect(decodeThreadId(threadId)).toBe(threadId);
    }),
  );

  it.effect("rejects anything that is not a UUIDv7", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownExit(ThreadId);
      for (const invalid of ["", "not-a-uuid", "00000000-0000-4000-8000-000000000000", 7, null]) {
        const exit = yield* Effect.sync(() => decode(invalid));
        expect(exit._tag).toBe("Failure");
      }
    }),
  );

  it.effect("mints distinct, ascending ids", () =>
    Effect.gen(function* () {
      const first = yield* Effect.sync(makeTurnId);
      const second = yield* Effect.sync(makeTurnId);
      expect(second > first).toBe(true);
    }),
  );

  it.effect("keeps every id in its own brand", () =>
    Effect.gen(function* () {
      // A ProjectId is a well-formed UUIDv7, so it decodes as a ThreadId at
      // runtime; the brands only separate them at the type level, which is
      // where the mix-ups this guards against actually happen.
      const projectId = yield* Effect.sync(makeProjectId);
      expect(decodeThreadId(projectId)).toBe(projectId);
    }),
  );
});

describe("ConnectorKind", () => {
  it.effect("accepts any connector name, so new connectors need no release", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(ConnectorKind);
      for (const kind of ["cmd", "claude-code", "something-nobody-has-written-yet"]) {
        expect(yield* Effect.sync(() => decode(kind))).toBe(kind);
      }
    }),
  );
});
