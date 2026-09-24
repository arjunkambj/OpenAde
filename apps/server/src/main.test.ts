import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { configDir } from "@poseidon/shared/paths";

describe("server", () => {
  it.effect("resolves the Poseidon config directory through @poseidon/shared", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.sync(() =>
        configDir({ POSEIDON_HOME: "/tmp/poseidon-server-test" }),
      );
      expect(dir).toBe("/tmp/poseidon-server-test");
    }),
  );
});
